// ==========================================================
// AlgoTrade — sniper-engine.js
// The Sniper Trader strategy, with no DOM access (sniper-trader.js
// is the UI that drives it).
//
//   - Waits for N digits in a row at/above (or at/below) a threshold.
//   - Then buys a digits contract (Under/Over).
//   - After a LOSS it buys again immediately (recovery trade), up to
//     `maxRecovery` recovery trades in a row, then goes back to
//     waiting for the pattern.
//   - Martingale: the stake is multiplied after EVERY loss, and only
//     a WIN resets it.
//   - Stops on take profit / stop loss / Stop button / any error.
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

function startSniperEngine(deps, cfg, hooks) {
  hooks = hooks || {};
  const log = hooks.log || function () {};
  const status = hooks.status || function () {};
  const stats = hooks.stats || function () {};
  const round2 = (x) => Math.round(x * 100) / 100;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const ms = (a, b) => Math.round(b - a) + " ms";

  // recoveryLocked: set when a full set of recovery trades fails. While locked, the bot only
  // takes pattern trades (martingale still running) and a loss does NOT start recovery mode.
  // The first win clears it, and only then can recovery mode start again.
  const st = { stake: cfg.stake, recovery: false, recCount: 0, recoveryLocked: false, profit: 0, trades: 0, wins: 0, window: [] };
  let running = true, busy = false, ended = false;
  let quote = null, offTick = null;
  let earlyDisabled = false;
  // Tick timing (used for the speed readout and for the optional fast loss reading)
  let lastTickAt = null, tickInterval = null;   // tickInterval: running average gap between ticks (ms)
  let current = null;                 // the contract we're waiting on: { confirmedAt, ticks:[{digit,at}], watch, firedEarly, kAtFinal }
  const fast = { enabled: false, k: null, streak: 0, need: 6 };
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });

  // ---------- Proposal / quote helpers (same request shape as trade.js) ----------
  function proposalReq(stake) {
    return {
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: cfg.contract,
      currency: cfg.currency,
      underlying_symbol: cfg.symbol,
      duration: cfg.duration,
      duration_unit: "t",
      barrier: String(cfg.prediction),
    };
  }

  // A live quote kept ready for the NEXT stake, so a buy can go out the
  // instant it's needed (the same cached-proposal approach Manual Trader uses).
  function openQuote(stake) {
    const q = { stake: stake, latest: null, updatedAt: null, error: null, unsub: null };
    try {
      q.unsub = deps.subscribe(proposalReq(stake), function (data) {
        if (data.error) { q.latest = null; q.error = data.error.message || "quote error"; return; }
        if (data.proposal) { q.latest = data.proposal; q.updatedAt = now(); q.error = null; }
      });
    } catch (_) { /* no cached quote: a fresh one is requested at buy time */ }
    return q;
  }
  function closeQuote(q) {
    if (q && q.unsub) { try { q.unsub(); } catch (_) {} }
  }
  function ensureQuote(stake) {
    if (quote && quote.stake === stake) return;
    closeQuote(quote);
    quote = openQuote(stake);
  }

  let lastTrace = "";   // how the most recent buy was made (shown in the timing line)
  let pendingFinal = null; // the previous contract's final "sold" update, while we're acting on the early read

  // Deriv refused the buy because of the quote itself (stale / expired / changed price).
  const QUOTE_PROBLEM = /proposal|price|expired|invalid|not found/i;
  // Deriv refused the buy because the previous contract isn't fully closed yet.
  const NOT_READY = /wait|clos|settl|still|already|open|pending/i;
  const pause = (t) => new Promise((res) => setTimeout(res, t));

  async function buyContract(stake) {
    const parts = [];
    let cached = quote && quote.stake === stake ? quote.latest : null;
    if (!cached) {
      parts.push(quote && quote.stake === stake
        ? (quote.error ? "quote error: " + quote.error : "no quote had arrived yet")
        : "no quote prepared for this stake");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let proposal = cached;
        if (proposal) {
          parts.push("cached quote, " + ms(quote.updatedAt, now()) + " old");
        } else {
          const tp = now();
          const res = await deps.send(proposalReq(stake));
          parts.push("fresh quote " + ms(tp, now()));
          if (!res.proposal) throw new Error((res.error && res.error.message) || "No price available for this trade.");
          proposal = res.proposal;
        }
        const tb = now();
        const r = await deps.send({ buy: proposal.id, price: proposal.ask_price });
        parts.push("buy " + ms(tb, now()));
        lastTrace = parts.join(" -> ");
        if (!r.buy || !r.buy.contract_id) throw new Error("Trade did not go through.");
        return r;
      } catch (e) {
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
  }
  const digitLoses = (d) => (cfg.contract === "DIGITOVER" ? !(d > cfg.prediction) : !(d < cfg.prediction));

  // Returns { earlyLoss, final }:
  //   earlyLoss resolves the moment an update shows the contract has ended on a LOSING digit;
  //   final resolves with the settled contract (is_sold / status no longer "open").
  // Re-subscribes if the socket is rebuilt.
  function watchContract(contractId) {
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
    const open = function () {
      if (unsub) { try { unsub(); } catch (_) {} }
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
          if (d !== null && digitLoses(d)) { earlySent = true; resolveEarly({ early: true }); }
        }
        if (settled) {
          if (current && current.watch === api) current.kAtFinal = current.ticks.length;
          cleanup(); resolveFinal(poc);
        }
      });
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
    closeQuote(quote);
    quote = null;
    status("Stopped");
    log("Bot stopped.");
    if (hooks.finished) hooks.finished();
    resolveDone();
  }

  const patternMet = () =>
    st.window.length === cfg.nDigits &&
    st.window.every((d) => (cfg.compare === "GTE" ? d >= cfg.threshold : d <= cfg.threshold));

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
        st.recovery = false; st.recCount = 0; st.recoveryLocked = true;
        return "Recovery limit reached - pattern trades only, recovery mode stays off until a pattern trade wins (stake kept).";
      }
    } else if (!st.recoveryLocked) {
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
      if (t && digitLoses(t.digit) !== actualLoss) {
        fast.enabled = false; fast.streak = 0; fast.need = 10;
      }
      return;
    }
    const k = rec.kAtFinal;
    const t = k ? rec.ticks[k - 1] : null;
    if (!t) { fast.streak = 0; return; }
    if (digitLoses(t.digit) === actualLoss) {
      if (k === fast.k) fast.streak++; else { fast.k = k; fast.streak = 1; }
    } else { fast.k = null; fast.streak = 0; }
    if (fast.streak >= fast.need) {
      fast.enabled = true;
    }
  }

  // The early (exit-digit) read said LOSS; this checks it against Deriv's final result.
  function reconcile(poc, stakeAtTrade, seenAt, fromTick, rec) {
    const actual = Number(poc.profit) || 0;
    if (!wonOf(poc)) learnFromFinal(rec, true);
    if (wonOf(poc)) {
      earlyDisabled = true;
      if (fromTick) { fast.enabled = false; fast.streak = 0; fast.need = 10; }
      st.wins++;
      st.profit = round2(st.profit + actual + stakeAtTrade); // replace the assumed loss with the real result
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
        const sentAt = nextBuy ? nextBuy.sentAt : now();
        const bought = await (nextBuy ? nextBuy.promise : buyContract(stakeNow));
        nextBuy = null;
        const confirmedAt = now();
        tickAt = null;
        if (lossSeenAt !== null && lossExitTickAt !== null && tickInterval !== null) {
          const afterExit = confirmedAt - lossExitTickAt;
          const spare = Math.round(tickInterval - afterExit);
        }
        lossSeenAt = null; lossExitTickAt = null;

        closeQuote(quote); // that quote is used up
        quote = null;
        // While this contract is open, get the quote for the stake we'd use after a loss.
        ensureQuote(round2(stakeNow * cfg.mult));
        if (hooks.bought) hooks.bought({ stake: stakeNow, contractId: bought.buy.contract_id });

        const watch = watchContract(bought.buy.contract_id);
        current = { confirmedAt: confirmedAt, ticks: [], watch: watch, firedEarly: false, kAtFinal: null };
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
        if (!hit && wouldBreachStop()) {
          hit = "Next stake " + st.stake.toFixed(2) + " could take the loss past the stop loss (" + cfg.sl + "). Stopped.";
        }
        if (hit) running = false;

        // Start the next buy BEFORE any screen/log work, so nothing delays it.
        if (running && st.recovery) {
          nextBuy = { promise: buyContract(st.stake), sentAt: now() };
          lossSeenAt = seenAt;
          lossExitTickAt = exitTickAt;
          lossResultLag = seenAt - exitTickAt;
        }

        if (hooks.settled) hooks.settled();
        pushStats();
        log((won ? "WON " : "LOST ") + profit.toFixed(2) + (provisional ? " (from exit tick)" : "") +
            " | total " + st.profit.toFixed(2) + " | next stake " + st.stake.toFixed(2));
        if (hit) log(hit);
        else if (!nextBuy) ensureQuote(st.stake); // keep a live quote ready for whatever comes next
        // Recovery loop: the next buy is already on its way — track it, no waiting for a tick.
      } while (nextBuy || (running && st.recovery));
    } catch (e) {
      log("Error: " + ((e && e.message) || "unknown") + " - bot stopped.");
      running = false;
    }
    busy = false;
    if (running) status("Waiting for pattern"); else end();
  }

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
      if (cfg.fastRead && fast.enabled && !current.firedEarly && current.ticks.length === fast.k && digitLoses(digit)) {
        current.firedEarly = true;
        current.watch.triggerEarly();
      }
    }
    st.window.push(digit);
    if (st.window.length > cfg.nDigits) st.window.shift();
    if (hooks.tickDigit) hooks.tickDigit(digit);
    if (running && !busy && patternMet()) cycle(arrivedAt);
  });

  ensureQuote(st.stake);
  status("Waiting for pattern");
  stats({ trades: 0, wins: 0, profit: 0, stake: st.stake });
  log("Started: waiting for " + cfg.nDigits + " digits " + (cfg.compare === "GTE" ? ">=" : "<=") + " " + cfg.threshold +
      ", then " + cfg.contract + " " + cfg.prediction + ".");

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

if (typeof module !== "undefined") module.exports = { startSniperEngine };
