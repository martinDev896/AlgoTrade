// ==========================================================
// AlgoTrade — sniper-evenodd-engine.js
// The Even/Odd Sniper Trader strategy, with no DOM access
// (sniper-evenodd.js is the UI that drives it).
//
//   - Watches the last digits. After N odd digits in a row it buys EVEN;
//     after N even digits in a row it buys ODD (the opposite of the run).
//     The contract setting can limit it to one side only.
//   - After a LOSS it buys the same contract again immediately (recovery
//     trade), up to `maxRecovery` recovery trades in a row. If they all
//     lose, recovery mode switches off and LOCKS: only pattern trades are
//     taken until one wins, and only then can recovery start again.
//   - Martingale: the stake is multiplied after EVERY loss, and only a
//     WIN resets it.
//   - Stops on take profit / stop loss / max trades / Stop button / any error.
//
// This is a sibling of sniper-engine.js (Over/Under). It is a separate
// file on purpose, so the Over/Under bot is untouched.
//
// SPEED (why a recovery buy can go out before Deriv's "sold" message):
//   A digits contract is decided by its exit tick's last digit. Deriv
//   publishes that exit tick as soon as the contract expires, and the
//   final "is_sold" update can arrive later. After a loss the engine
//   reads the exit digit straight from that early update, starts the
//   next buy immediately (using a quote cached while the contract was
//   open), and only afterwards reconciles with the final result. A win
//   always waits for the final result (no speed needed there). If the
//   early read ever disagrees with the final result, the engine logs a
//   warning and switches the early path off for the rest of the run.
//   The log shows timings so you can see where any remaining delay is.
//
// It talks to Deriv only through the `deps` it is given (send /
// subscribe from the app's own derivAPI), so it uses the same
// connection, proposal and buy requests as Manual Trader — it never
// authorizes or connects anything itself.
// ==========================================================

function startEvenOddEngine(deps, cfg, hooks) {
  hooks = hooks || {};
  const log = hooks.log || function () {};
  // `status` remembers the last status so it can be restored after a reconnect, and stays quiet while reconnecting.
  let lastStatus = "", reconnectNoticeOn = false;
  const status = function (s) { lastStatus = s; if (!reconnectNoticeOn && hooks.status) hooks.status(s); };
  const stats = hooks.stats || function () {};
  const round2 = (x) => Math.round(x * 100) / 100;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const ms = (a, b) => Math.round(b - a) + " ms";

  // recoveryLocked: set when a full set of recovery trades fails. While locked, the bot only
  // takes pattern trades (martingale still running) and a loss does NOT start recovery mode.
  // The first win clears it, and only then can recovery mode start again.
  const st = { stake: cfg.stake, contract: null, recovery: false, recCount: 0, recoveryLocked: false, profit: 0, trades: 0, wins: 0, window: [] };
  let running = true, busy = false, ended = false;
  let offTick = null, offReconnect = null, watchdog = null, lastSpecs = null;
  let earlyDisabled = false;
  // Tick timing (used for the speed readout and for the optional fast loss reading)
  let lastTickAt = null, tickInterval = null;   // tickInterval: running average gap between ticks (ms)
  let current = null;                 // the contract we're waiting on: { confirmedAt, ticks:[{digit,at}], watch, firedEarly, kAtFinal }
  const fast = { enabled: false, k: null, streak: 0, need: 6 };
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });

  // ---------- Proposal / quote helpers (same request shape as trade.js) ----------
  // Even/Odd contracts have no barrier / prediction digit.
  function proposalReq(contract, stake) {
    return {
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: contract,
      currency: cfg.currency,
      underlying_symbol: cfg.symbol,
      duration: cfg.duration,
      duration_unit: "t",
    };
  }

  // Which contracts the chosen setting allows: "both" (opposite of the run), "even" only, or "odd" only.
  function allowedContracts() {
    return cfg.mode === "even" ? ["DIGITEVEN"] : cfg.mode === "odd" ? ["DIGITODD"] : ["DIGITEVEN", "DIGITODD"];
  }

  // Live quotes kept ready, keyed by "CONTRACT|stake", so a buy can go out the instant it is
  // needed (the same cached-proposal approach Manual Trader uses).
  const quotes = new Map();
  const qKey = (contract, stake) => contract + "|" + stake;
  function openQuote(contract, stake) {
    const q = { contract: contract, stake: stake, latest: null, updatedAt: null, error: null, unsub: null, socket: socketId() };
    try {
      q.unsub = deps.subscribe(proposalReq(contract, stake), function (data) {
        if (data.error) { q.latest = null; q.error = data.error.message || "quote error"; return; }
        if (data.proposal) { q.latest = data.proposal; q.updatedAt = now(); q.error = null; }
      });
    } catch (_) { /* no cached quote: a fresh one is requested at buy time */ }
    return q;
  }
  function closeQuote(q) {
    if (q && q.unsub) { try { q.unsub(); } catch (_) {} }
  }
  function closeAllQuotes() {
    quotes.forEach(closeQuote);
    quotes.clear();
  }
  // Keep exactly these quotes open (closes the others, opens any that are missing).
  function setQuotes(specs) {
    lastSpecs = specs;
    const want = new Set(specs.map((x) => qKey(x.contract, x.stake)));
    quotes.forEach(function (q, k) { if (!want.has(k)) { closeQuote(q); quotes.delete(k); } });
    specs.forEach(function (x) {
      const k = qKey(x.contract, x.stake);
      if (!quotes.has(k)) quotes.set(k, openQuote(x.contract, x.stake));
    });
  }
  const patternQuotes = (stake) => allowedContracts().map((c) => ({ contract: c, stake: stake }));

  let lastTrace = "";   // how the most recent buy was made (shown in the timing line)
  let pendingFinal = null; // the previous contract's final "sold" update, while we're acting on the early read

  // Deriv refused the buy because of the quote itself (stale / expired / changed price).
  const QUOTE_PROBLEM = /proposal|price|expired|invalid|not found/i;
  // Deriv refused the buy because the previous contract isn't fully closed yet.
  const NOT_READY = /wait|clos|settl|still|already|open|pending/i;
  const pause = (t) => new Promise((res) => setTimeout(res, t));

  // ---------- Connection resilience ----------
  // The app's socket can drop and rebuild itself (api.js / auth.js). While that happens the bot PAUSES
  // and carries on by itself instead of stopping:
  //  - requests wait for the connection to be back (up to 3 minutes),
  //  - a request that never left the browser (socket still "CONNECTING") is simply sent again,
  //  - a lost price request is simply asked again,
  //  - a BUY whose reply was lost is checked against Deriv's own records first, so it is never bought twice,
  //  - contract watching and price quotes are re-opened on the new connection.
  const RECONNECT_WAIT_MS = cfg.reconnectWaitMs || 180000;
  const isOpen = () => (deps.isOpen ? deps.isOpen() : true);
  const socketId = () => (deps.socketId ? deps.socketId() : null);
  const NOT_SENT = /Still in CONNECTING|CLOSING|CLOSED|not open|not connected/i;
  const trackedContracts = new Set();
  function stopAbortError() { const e = new Error("Stopped"); e.stopAbort = true; return e; }

  // Shown whenever the connection is down while the bot runs (a watchdog also calls these, so the
  // screen says "Reconnecting…" even when the bot is only waiting for a contract result).
  function markDown() {
    if (reconnectNoticeOn) return;
    reconnectNoticeOn = true;
    if (hooks.status) hooks.status("Reconnecting…");
    log("Connection lost - waiting to reconnect. The bot resumes by itself.");
  }
  function markUp() {
    if (!reconnectNoticeOn) return;
    reconnectNoticeOn = false;
    if (hooks.status && lastStatus) hooks.status(lastStatus);
    log("Reconnected - bot resumed.");
  }

  async function waitForConnection() {
    if (isOpen()) return;
    const t0 = now();
    markDown();
    while (!isOpen()) {
      if (ended) throw stopAbortError();
      if (now() - t0 > RECONNECT_WAIT_MS) throw new Error("Connection was not restored in time. Check your open positions on Deriv");
      await pause(250);
    }
    await pause(400);   // let the new connection settle
    markUp();
  }

  // ctx is given for BUY requests only: { contract, stake }.
  async function sendSafe(req, ctx) {
    const sentEpoch = Math.floor(Date.now() / 1000);
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      await waitForConnection();
      if (ctx && !running) throw stopAbortError();                  // Stop was pressed before the buy left
      try {
        return await deps.send(req);
      } catch (e) {
        lastErr = e;
        const msg = (e && e.message) || "";
        if ((e && e.notSent) || NOT_SENT.test(msg)) continue;       // it never left the browser: send it again
        if (e && (e.connectionLost || e.timeout)) {
          if (!ctx) continue;                                       // a lost price request is harmless
          const found = await findPurchasedContract(ctx, sentEpoch);   // did the buy go through?
          if (found) {
            log("Connection dropped while buying - the trade had gone through, carrying on with it.");
            return { buy: { contract_id: found } };
          }
          continue;                                                 // confirmed NOT bought: try again
        }
        throw e;
      }
    }
    throw lastErr || new Error("Connection kept dropping");
  }

  // After a lost buy reply: look in Deriv's open positions and recent closed trades for it.
  // Only when BOTH lists could be read and neither has it do we treat the buy as "not placed".
  async function findPurchasedContract(ctx, sentEpoch) {
    await waitForConnection();
    await pause(1500);                       // give Deriv a moment to finish anything it was processing
    const untracked = (id) => !trackedContracts.has(String(id));
    const recent = (t) => Number(t) >= sentEpoch - 30;
    const sameStake = (p) => Math.abs(Number(p) - ctx.stake) < 0.005;
    let checked = 0;
    try {
      const pf = await sendSafe({ portfolio: 1 });
      const list = pf.portfolio && pf.portfolio.contracts;
      if (Array.isArray(list)) {
        checked++;
        const hit = list.find((c) => c.contract_type === ctx.contract && sameStake(c.buy_price) && recent(c.purchase_time) && untracked(c.contract_id));
        if (hit) return hit.contract_id;
      }
    } catch (_) { /* counted as not checked */ }
    try {
      const pt = await sendSafe({ profit_table: 1, description: 1, limit: 15, sort: "DESC" });
      const list = pt.profit_table && pt.profit_table.transactions;
      if (Array.isArray(list)) {
        checked++;
        const hit = list.find((t) => String(t.shortcode || "").indexOf(ctx.contract) === 0 && sameStake(t.buy_price) && recent(t.purchase_time) && untracked(t.contract_id));
        if (hit) return hit.contract_id;
      }
    } catch (_) { /* counted as not checked */ }
    if (checked < 2) throw new Error("Connection dropped while placing a trade and Deriv's records could not be checked. Check your open positions");
    return null;
  }

  async function buyContract(contract, stake) {
    const parts = [];
    const q = quotes.get(qKey(contract, stake));
    let cached = q && q.socket === socketId() ? q.latest : null;
    if (!cached) {
      parts.push(q ? (q.error ? "quote error: " + q.error : "no quote had arrived yet") : "no quote prepared for this stake");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let proposal = cached;
        if (proposal) {
          parts.push("cached quote, " + ms(q.updatedAt, now()) + " old");
        } else {
          const tp = now();
          const res = await sendSafe(proposalReq(contract, stake));
          parts.push("fresh quote " + ms(tp, now()));
          if (!res.proposal) throw new Error((res.error && res.error.message) || "No price available for this trade.");
          proposal = res.proposal;
        }
        const tb = now();
        const r = await sendSafe({ buy: proposal.id, price: proposal.ask_price }, { contract: contract, stake: stake });
        parts.push("buy " + ms(tb, now()));
        lastTrace = parts.join(" -> ");
        if (!r.buy || !r.buy.contract_id) throw new Error("Trade did not go through.");
        return r;
      } catch (e) {
        if (e && e.stopAbort) { lastTrace = parts.join(" -> "); throw e; }
        const msg = (e && e.message) || "";
        parts.push("buy REJECTED (" + msg + ")");
        // A rejected buy created no contract, so one retry is safe.
        if (attempt === 0 && pendingFinal && NOT_READY.test(msg)) {
          const tw = now();
          await Promise.race([pendingFinal, pause(5000)]);   // let the previous contract close first
          parts.push("waited " + ms(tw, now()) + " for the previous contract to close");
          cached = null;
          continue;
        }
        if (attempt === 0 && cached && QUOTE_PROBLEM.test(msg)) { cached = null; continue; }
        lastTrace = parts.join(" -> ");
        throw e;
      }
    }
  }

  // ---------- Contract watching ----------
  const wonOf = (poc) => (poc.status ? poc.status === "won" : Number(poc.profit) > 0);

  // Last digit of the exit tick, read from the contract update itself.
  const EXIT_DISPLAY_FIELDS = ["exit_tick_display_value", "exit_spot_display_value", "sell_spot_display_value"];
  const EXIT_RAW_FIELDS = ["exit_tick", "exit_spot", "sell_spot"];
  function exitDigitOf(poc) {
    for (let i = 0; i < EXIT_DISPLAY_FIELDS.length; i++) {
      const v = poc[EXIT_DISPLAY_FIELDS[i]];
      if (v !== undefined && v !== null && String(v) !== "") return Number(String(v).slice(-1));
    }
    for (let i = 0; i < EXIT_RAW_FIELDS.length; i++) {
      const v = poc[EXIT_RAW_FIELDS[i]];
      if (v !== undefined && v !== null && String(v) !== "") return Number(Number(v).toFixed(cfg.pipDecimals).slice(-1));
    }
    return null;
  }

  // Diagnostic: shows exactly what Deriv's contract updates contain and when they arrive
  // (first two contracts of a run only, to keep the log short).
  let debugContracts = 0;
  function debugUpdate(poc, openedAt, label) {
    const f = function (k) { return poc[k] === undefined ? "-" : String(poc[k]); };
    log("debug " + label + " +" + ms(openedAt, now()) + ": status=" + f("status") + " expired=" + f("is_expired") + " sold=" + f("is_sold") +
        " exit_tick=" + f("exit_tick") + " exit_display=" + f("exit_tick_display_value") + " sell_spot=" + f("sell_spot") +
        " tick_count=" + f("tick_count") + " | fields: " + Object.keys(poc).join(","));
  }
  // EVEN loses on an odd exit digit; ODD loses on an even exit digit.
  const digitLoses = (d, contract) => (contract === "DIGITEVEN" ? d % 2 !== 0 : d % 2 === 0);

  // Returns { earlyLoss, final }:
  //   earlyLoss resolves the moment an update shows the contract has ended on a LOSING digit;
  //   final resolves with the settled contract (is_sold / status no longer "open").
  // Re-subscribes if the socket is rebuilt.
  function watchContract(contractId, contract) {
    let unsub = null, offRe = null, finished = false, earlySent = false;
    let resolveEarly, resolveFinal, rejectFinal;
    const openedAt = now();
    const doDebug = debugContracts < 2;
    let tickTrigger = false;
    debugContracts++;
    let lastSig = "";
    const earlyLoss = new Promise((res) => { resolveEarly = res; });
    const final = new Promise((res, rej) => { resolveFinal = res; rejectFinal = rej; });
    const cleanup = function () {
      finished = true;
      if (unsub) { try { unsub(); } catch (_) {} }
      if (offRe) offRe();
    };
    let subSocket = null;
    const open = function () {
      if (finished) return;
      const sid = socketId();
      if (unsub && sid !== null && subSocket === sid) return;     // already watching on this connection
      if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
      try {
      unsub = deps.subscribe({ proposal_open_contract: 1, contract_id: contractId }, function (data) {
        if (finished) return;
        if (data.error) { cleanup(); return rejectFinal(new Error(data.error.message || "Could not watch the contract.")); }
        const poc = data.proposal_open_contract;
        if (!poc) return;
        const settled = poc.is_sold || (poc.status && poc.status !== "open");
        if (doDebug) {
          const sig = [poc.status, poc.is_expired, poc.is_sold, poc.exit_tick, poc.tick_count].join("|");
          if (sig !== lastSig) { lastSig = sig; debugUpdate(poc, openedAt, "update"); }   // only when something changed
        }
        if (!earlyDisabled && !earlySent && (poc.is_expired || settled)) {
          const d = exitDigitOf(poc);
          if (d !== null && digitLoses(d, contract)) { earlySent = true; resolveEarly({ early: true }); }
        }
        if (settled) {
          if (current && current.watch === api) current.kAtFinal = current.ticks.length;
          cleanup(); resolveFinal(poc);
        }
      });
      subSocket = sid;
      } catch (e) {
        // The socket is not ready right now (e.g. still CONNECTING): try again as soon as it is back.
        unsub = null; subSocket = null;
        waitForConnection().then(
          function () { if (!finished) open(); },
          function (err) { if (!finished) { cleanup(); rejectFinal(err); } });
      }
    };
    open();
    offRe = deps.onReconnect ? deps.onReconnect(open) : null;
    const api = {
      earlyLoss: earlyLoss,
      final: final,
      // Fast loss reading: the exit tick has arrived on the tick feed and it is a losing digit.
      triggerEarly: function () { if (!earlySent && !finished) { earlySent = true; tickTrigger = true; resolveEarly({ early: true, fromTick: true }); } },
    };
    return api;
  }

  function end() {
    if (ended) return;
    ended = true;
    running = false;
    if (offTick) offTick();
    if (offReconnect) offReconnect();
    if (watchdog) clearInterval(watchdog);
    reconnectNoticeOn = false;
    closeAllQuotes();
    status("Stopped");
    log("Bot stopped.");
    if (hooks.finished) hooks.finished();
    resolveDone();
  }

  // N odd digits in a row -> EVEN; N even digits in a row -> ODD (limited by the contract setting).
  function patternContract() {
    if (st.window.length < cfg.nDigits) return null;
    const allOdd = st.window.every((d) => d % 2 === 1);
    const allEven = st.window.every((d) => d % 2 === 0);
    if (allOdd && cfg.mode !== "odd") return "DIGITEVEN";
    if (allEven && cfg.mode !== "even") return "DIGITODD";
    return null;
  }

  function pushStats() {
    stats({ trades: st.trades, wins: st.wins, profit: st.profit, stake: st.stake });
  }
  // Optional hard stop loss: never place a trade whose stake could take the total loss past the stop loss.
  function wouldBreachStop() {
    return !!cfg.hardStop && round2(st.profit - st.stake) < -cfg.sl;
  }
  function limitHit() {
    if (st.profit >= cfg.tp) return "Take profit reached. Stopped.";
    if (st.profit <= -cfg.sl) return "Stop loss reached. Stopped.";
    return null;
  }

  // Applies one trade's result to the martingale / recovery state.
  //   - Pattern trade loses (not locked)  -> recovery mode ON (up to maxRecovery trades, right away).
  //   - Recovery trades all lose          -> recovery OFF and LOCKED: only pattern trades until one wins.
  //   - Pattern trade loses while locked  -> stays pattern-only (stake keeps growing, no recovery).
  //   - Any win                           -> stake reset, recovery unlocked (can start again on the next loss).
  function applyOutcome(won, profit) {
    st.trades++;
    st.profit = round2(st.profit + profit);
    if (won) {
      const wasLocked = st.recoveryLocked;
      st.wins++; st.stake = cfg.stake; st.recovery = false; st.recCount = 0; st.recoveryLocked = false;
      return wasLocked ? "Pattern trade won - stake reset and recovery mode is armed again." : null;
    }
    const wasRecovery = st.recovery;
    st.stake = round2(st.stake * cfg.mult); // martingale: only a win resets it
    if (wasRecovery) {
      st.recCount++;
      if (st.recCount >= cfg.maxRecovery) {
        st.recovery = false; st.recCount = 0;
        if (cfg.cooldown) {
          // Cooldown: act as if starting again. The stake goes back to the starting stake and recovery stays
          // available, so the next pattern trade (at the starting stake) can start martingale + recovery again.
          // Profit/loss, trade count and everything else recorded so far are left as they are.
          st.stake = cfg.stake; st.recoveryLocked = false;
          return "Recovery limit reached - cooldown: stake reset to the starting stake, starting again.";
        }
        st.recoveryLocked = true;
        return "Recovery limit reached - pattern trades only, recovery mode stays off until a pattern trade wins (stake kept).";
      }
    } else if (!st.recoveryLocked && cfg.maxRecovery > 0) {
      st.recovery = true; st.recCount = 0;
    }
    return null;
  }

  // Fast loss reading: learns how many ticks after the buy the result appears, and switches on only
  // after the same tick position has predicted the real outcome several trades in a row.
  function learnFromFinal(rec, actualLoss) {
    if (!cfg.fastRead || !rec) return;
    if (fast.enabled) {
      const t = rec.ticks[fast.k - 1];
      if (t && digitLoses(t.digit, rec.contract) !== actualLoss) {
        fast.enabled = false; fast.streak = 0; fast.need = 10;
        log("Fast loss reading switched off: tick " + fast.k + " did not match Deriv's result. It will re-learn.");
      }
      return;
    }
    const k = rec.kAtFinal;
    const t = k ? rec.ticks[k - 1] : null;
    if (!t) { fast.streak = 0; return; }
    if (digitLoses(t.digit, rec.contract) === actualLoss) {
      if (k === fast.k) fast.streak++; else { fast.k = k; fast.streak = 1; }
    } else { fast.k = null; fast.streak = 0; }
    if (fast.streak >= fast.need) {
      fast.enabled = true;
      log("Fast loss reading ON: the result is decided by tick " + fast.k + " after the buy (confirmed on " + fast.streak + " trades in a row).");
    }
  }

  // The early (exit-digit) read said LOSS; this checks it against Deriv's final result.
  function reconcile(poc, stakeAtTrade, seenAt, fromTick, rec) {
    const actual = Number(poc.profit) || 0;
    log("timing: Deriv's final 'sold' update came " + ms(seenAt, now()) + " after the loss was seen from the exit tick.");
    if (!wonOf(poc)) learnFromFinal(rec, true);
    if (wonOf(poc)) {
      earlyDisabled = true;
      if (fromTick) { fast.enabled = false; fast.streak = 0; fast.need = 10; }
      st.wins++;
      st.profit = round2(st.profit + actual + stakeAtTrade); // replace the assumed loss with the real result
      log(fromTick
        ? "WARNING: fast loss reading was wrong on that trade (it was a WIN). It is switched off and will re-learn."
        : "WARNING: that trade was actually a WIN. Early reading switched off for the rest of this run.");
      pushStats();
    } else if (Math.abs(actual + stakeAtTrade) > 0.005) {
      st.profit = round2(st.profit + actual + stakeAtTrade);
      pushStats();
    }
    const hit = limitHit();
    if (hit && running) { log(hit); running = false; if (!busy) end(); }
  }

  async function cycle(tickAt) {
    busy = true;
    let nextBuy = null;   // a recovery buy already sent, waiting to be tracked
    let lossSeenAt = null, lossExitTickAt = null, lossResultLag = 0;
    try {
      do {
        status(st.recovery ? "Recovery trade" : "Pattern trade");
        const stakeNow = st.stake;
        const contractNow = st.contract;       // a recovery trade repeats the contract that just lost
        const sentAt = nextBuy ? nextBuy.sentAt : now();
        if (tickAt !== null) {
          const run = contractNow === "DIGITEVEN" ? "odd" : "even";
          log("Pattern: " + cfg.nDigits + " " + run + " digits in a row -> buying " + (contractNow === "DIGITEVEN" ? "EVEN" : "ODD") + " (stake " + stakeNow.toFixed(2) + ").");
        }
        const bought = await (nextBuy ? nextBuy.promise : buyContract(contractNow, stakeNow));
        nextBuy = null;
        const confirmedAt = now();
        trackedContracts.add(String(bought.buy.contract_id));
        log(lossSeenAt !== null
          ? "timing: loss seen -> next buy confirmed in " + ms(lossSeenAt, confirmedAt) + " [" + lastTrace + "]"
          : (tickAt !== null ? "timing: pattern tick -> buy confirmed in " + ms(tickAt, confirmedAt) + " [" + lastTrace + "]" : ""));
        tickAt = null;
        if (lossSeenAt !== null && lossExitTickAt !== null && tickInterval !== null) {
          const afterExit = confirmedAt - lossExitTickAt;
          const spare = Math.round(tickInterval - afterExit);
          log("speed: result reached us " + Math.round(lossResultLag) + " ms after the exit tick; the next buy was confirmed " + Math.round(afterExit) +
              " ms after it; ticks come every ~" + Math.round(tickInterval) + " ms -> " +
              (spare > 0 ? "lands before the next tick (" + spare + " ms to spare)." : "MISSED the next tick by " + (-spare) + " ms."));
        }
        lossSeenAt = null; lossExitTickAt = null;

        // That quote is used up. While this contract is open, get the quote for the stake we'd use after a loss.
        const used = quotes.get(qKey(contractNow, stakeNow));
        closeQuote(used); quotes.delete(qKey(contractNow, stakeNow));
        setQuotes([{ contract: contractNow, stake: round2(stakeNow * cfg.mult) }]);
        if (hooks.bought) hooks.bought({ stake: stakeNow, contractId: bought.buy.contract_id, contract: contractNow });

        const watch = watchContract(bought.buy.contract_id, contractNow);
        current = { confirmedAt: confirmedAt, ticks: [], watch: watch, firedEarly: false, kAtFinal: null, contract: contractNow };
        const rec = current;
        const first = await Promise.race([watch.earlyLoss, watch.final]);
        const seenAt = now();
        const exitTickAt = lastTickAt;   // the most recent tick before the result reached us
        let won, profit, provisional = false;
        if (first && first.early) {
          won = false; profit = -stakeNow; provisional = true;
          const finalP = watch.final.then(
            function (poc) { if (pendingFinal === finalP) pendingFinal = null; reconcile(poc, stakeNow, seenAt, first.fromTick, rec); },
            function () { if (pendingFinal === finalP) pendingFinal = null; });
          pendingFinal = finalP;
        } else {
          won = wonOf(first);
          profit = Number(first.profit) || 0;
          learnFromFinal(rec, !won);
        }

        const note = applyOutcome(won, profit);
        let hit = limitHit();
        if (!hit && cfg.maxTrades > 0 && st.trades >= cfg.maxTrades) hit = "Max trades (" + cfg.maxTrades + ") reached. Stopped.";
        if (!hit && wouldBreachStop()) {
          hit = "Next stake " + st.stake.toFixed(2) + " could take the loss past the stop loss (" + cfg.sl + "). Stopped.";
        }
        if (hit) running = false;

        // Start the next buy BEFORE any screen/log work, so nothing delays it.
        if (running && st.recovery) {
          nextBuy = { promise: buyContract(st.contract, st.stake), sentAt: now() };
          lossSeenAt = seenAt;
          lossExitTickAt = exitTickAt;
          lossResultLag = seenAt - exitTickAt;
        }

        if (hooks.settled) hooks.settled();
        pushStats();
        log((won ? "WON " : "LOST ") + profit.toFixed(2) + (provisional ? " (from exit tick)" : "") +
            " | total " + st.profit.toFixed(2) + " | next stake " + st.stake.toFixed(2));
        if (note) log(note);
        if (hit) log(hit);
        else if (!nextBuy) setQuotes(patternQuotes(st.stake)); // keep live quotes ready for the next pattern
        // Recovery loop: the next buy is already on its way — track it, no waiting for a tick.
      } while (nextBuy || (running && st.recovery));
    } catch (e) {
      if (!(e && e.stopAbort)) log("Error: " + ((e && e.message) || "unknown") + " - bot stopped.");
      running = false;
    }
    busy = false;
    if (running) status("Waiting for pattern"); else end();
  }

  // After a reconnect: ticks were missed (a pattern must be built from fresh digits), the learned
  // exit-tick position can't be trusted, and the old price quotes belonged to the old connection.
  offReconnect = deps.onReconnect ? deps.onReconnect(function () {
    st.window.length = 0;
    fast.enabled = false; fast.streak = 0;
    quotes.clear();
    if (lastSpecs) setQuotes(lastSpecs);
  }) : null;

  watchdog = deps.isOpen ? setInterval(function () {
    if (ended) return;
    if (!isOpen()) markDown(); else if (reconnectNoticeOn) markUp();
  }, 500) : null;

  offTick = deps.onTick(function (t) {
    if (ended || t.symbol !== cfg.symbol) return;
    const arrivedAt = now();
    const digit = Number(Number(t.quote).toFixed(cfg.pipDecimals).slice(-1));
    if (lastTickAt !== null) {
      const gap = arrivedAt - lastTickAt;
      if (gap > 50 && gap < 10000) tickInterval = tickInterval === null ? gap : tickInterval * 0.7 + gap * 0.3;
    }
    lastTickAt = arrivedAt;
    if (current) {
      current.ticks.push({ digit: digit, at: arrivedAt });
      if (cfg.fastRead && fast.enabled && !current.firedEarly && current.ticks.length === fast.k && digitLoses(digit, current.contract)) {
        current.firedEarly = true;
        current.watch.triggerEarly();
      }
    }
    st.window.push(digit);
    if (st.window.length > cfg.nDigits) st.window.shift();
    if (hooks.tickDigit) hooks.tickDigit(digit);
    if (running && !busy) {
      const c = patternContract();
      if (c) { st.contract = c; cycle(arrivedAt); }
    }
  });

  setQuotes(patternQuotes(st.stake));
  status("Waiting for pattern");
  stats({ trades: 0, wins: 0, profit: 0, stake: st.stake });
  log("Started: " + (cfg.mode === "odd" ? "" : "after " + cfg.nDigits + " odd digits in a row -> EVEN") +
      (cfg.mode === "both" ? "; " : "") + (cfg.mode === "even" ? "" : "after " + cfg.nDigits + " even digits in a row -> ODD") + ".");

  return {
    done: done,
    stop: function () {
      if (!running) return;
      running = false;
      if (!busy) end();
      else { status("Stopping…"); log("Stop requested - waiting for the open contract to settle."); }
    },
  };
}

if (typeof module !== "undefined") module.exports = { startEvenOddEngine };
