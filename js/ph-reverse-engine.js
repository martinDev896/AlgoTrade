// ==========================================================
// AlgoTrade — ph-reverse-engine.js
// The "PH Reverse" strategy, with no DOM access (pro-hedging.js is
// the UI that drives it). A sibling of sniper-engine.js and
// sniper-evenodd-engine.js: those files are untouched.
//
// STRATEGY (PH Reverse)
//   ENTRY     Same as Pro Hedging: wait for N digits in a row with NONE 4 or 5,
//             then buy Over 3 and Under 6 together.
//   OUTCOMES  Both win -> reset martingale. If one loses, recover only that side.
//             Over 3 loss -> Under 5. Under 6 loss -> Over 4.
//   RECOVERY  Stage 1: wait for P consecutive digits that WIN the recovery contract
//             (Under 5: 0-4; Over 4: 5-9). A losing digit resets this count.
//             Stage 2: wait for K consecutive digits that LOSE the recovery contract
//             (Under 5: 5-9; Over 4: 0-4). A winning digit resets both stages.
//             Buy is initiated from the tick callback that completes Stage 2.
//             After the first recovery loss, use Recovery strength P/K settings.
//             Immediate recovery ON retains the existing immediate re-buy behaviour
//             and bypasses the digit pattern; OFF requires the active P/K pattern.
//   RISK      Existing Pro Hedging risk controls and settlement/accounting are retained.
//   RESULTS   Contract results are taken from Deriv confirmations; fast recovery keeps
//             the existing estimated-loss reconciliation behaviour.
//
// It talks to Deriv only through `deps` (send / subscribe from the app's own
// derivAPI), so it uses the same connection, proposal and buy requests as
// Manual Trader. It never authorizes or connects anything itself.
// ==========================================================

const PH_REVERSE_RULES = {
  OVER:  { side: "OVER",  contract: "DIGITOVER",  barrier: 3, recBarrier: 5, name: "Over" },
  UNDER: { side: "UNDER", contract: "DIGITUNDER", barrier: 6, recBarrier: 4, name: "Under" },
  skipDigits: [4, 5],   // entry needs N digits in a row that are none of these
};

function startPHReverseEngine(deps, cfg, hooks) {
  hooks = hooks || {};
  const noop = function () {};
  const log = hooks.log || noop;
  const round2 = (x) => Math.round(x * 100) / 100;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const ms = (a, b) => Math.round(b - a) + " ms";
  const pause = (t) => new Promise((res) => setTimeout(res, t));

  const S = cfg.stake;
  const OVER = PH_REVERSE_RULES.OVER, UNDER = PH_REVERSE_RULES.UNDER;
  const SKIP = new Set(PH_REVERSE_RULES.skipDigits);
  const PAT = Math.max(1, Math.floor(cfg.recPattern || 1));   // consecutive winning digits before the losing-digit confirmation

  // ---------- State ----------
  const st = { mode: "waiting", entryCount: 0, carry: 0, startedAt: Date.now() };
  // carry = martingale level carried between recovery cycles. It is 0 at the start, goes back to 0 ONLY when a
  // recovery cycle wins (or both initial contracts win), and is kept when a cycle ends without a win
  // (unless the "when the limit is reached" setting says otherwise).
  const rows = [];                 // every contract bought: the trade history
  let rowSeq = 0;
  let running = true, ended = false;
  let entryBusy = false;           // an entry cycle (two contracts) is in progress
  let activeOps = 0;               // entry cycles / recovery loops currently executing
  let inflight = 0;                // contracts bought and not yet confirmed
  let rec = null;                  // the active recovery leg, if any
  const recQueue = [];             // recovery legs waiting their turn (only >1 if both entry contracts lost)
  let lastDigit = null;
  let earlyDisabled = false;
  let reconnectNoticeOn = false;
  let offTick = null, offReconnect = null, watchdog = null;
  let pendingFinal = null, lastTrace = "";
  const trackedContracts = new Set();
  const bal = { value: null };     // account balance (read from Deriv, then kept up to date locally)
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });

  // ---------- Contract specs ----------
  const initialSpec = (r) => ({ side: r.side, contract: r.contract, barrier: r.barrier, label: r.name + " " + r.barrier, duration: cfg.duration });
  const recoverySpec = (r) => ({ side: r.side, contract: r.contract, barrier: r.recBarrier, label: r.name + " " + r.recBarrier, duration: cfg.recDuration });
  const specLoses = (spec, d) => (spec.contract === "DIGITOVER" ? !(d > spec.barrier) : !(d < spec.barrier));
  const ruleOf = (side) => (side === "OVER" ? OVER : UNDER);
  // Reverse recovery mapping: a lost Over 3 is recovered with Under 5;
  // a lost Under 6 is recovered with Over 4. The initial entry rules remain unchanged.
  const recoveryRuleOf = (initialSide) => initialSide === "OVER"
    ? { side: "UNDER", contract: "DIGITUNDER", recBarrier: 5, name: "Under" }
    : { side: "OVER", contract: "DIGITOVER", recBarrier: 4, name: "Over" };
  const recStake = (leg) => round2(S * Math.pow(cfg.mult, leg.level));

  // ---------- Totals (always recomputed from the history, so they can never drift) ----------
  function totals() {
    let profit = 0, wins = 0, losses = 0, estimated = false, open = 0;
    rows.forEach(function (r) {
      if (r.status === "open") { open++; return; }
      profit += r.profit;
      if (r.status === "won") wins++; else losses++;
      if (!r.confirmed) estimated = true;
    });
    return { profit: round2(profit), wins: wins, losses: losses, estimated: estimated, open: open };
  }

  function snapshot() {
    const t = totals();
    let curStake = S, nextRec = round2(S * Math.pow(cfg.mult, st.carry + 1));
    if (rec) {
      if (rec.phase !== "open") { curStake = recStake(rec); nextRec = curStake; }
      else { curStake = rec.openStake || recStake(rec); nextRec = round2(S * Math.pow(cfg.mult, rec.level + 1)); }
    }
    return {
      mode: st.mode, running: running, reconnecting: reconnectNoticeOn,
      symbol: cfg.symbol, lastDigit: lastDigit,
      entryCount: st.mode === "waiting" ? Math.min(st.entryCount, cfg.nEntry) : 0, entryNeed: cfg.nEntry,
      patCount: rec && rec.phase === "winning" ? Math.min(rec.patCount, rec.patternNeed) : 0, patNeed: rec ? rec.patternNeed : PAT,
      recCount: rec && rec.phase === "confirm" ? Math.min(rec.count, rec.confirmNeed) : 0, recNeed: rec ? rec.confirmNeed : cfg.recConfirm,
      recPhase: rec ? rec.phase : null,
      recContract: rec ? rec.label : null,
      recTrades: rec ? rec.trades : 0, maxRec: cfg.maxRec,
      level: rec ? rec.level : st.carry, carry: st.carry,
      stake: curStake, nextRecStake: nextRec,
      bought: rows.length, wins: t.wins, losses: t.losses, open: t.open,
      profit: t.profit, estimated: t.estimated,
      tp: cfg.tp, sl: cfg.sl,
      startedAt: st.startedAt,
      balance: bal.value,
    };
  }
  const emitState = function () { if (hooks.state) hooks.state(snapshot()); };
  function setMode(m) { st.mode = m; }

  // ---------- Trade history rows ----------
  function addRow(spec, phase, stake, contractId, level) {
    const row = { id: ++rowSeq, time: Date.now(), contractId: contractId, phase: phase, label: spec.label, barrier: spec.barrier,
      stake: stake, level: level, status: "open", profit: null, confirmed: false, credited: 0 };
    rows.push(row);
    if (hooks.trade) hooks.trade(Object.assign({}, row));
    return row;
  }
  function setRow(row, won, profit, confirmed) {
    const credit = won ? round2(row.stake + profit) : 0;   // what Deriv paid back for this contract
    adjustBalance(round2(credit - row.credited));
    row.credited = credit;
    row.status = won ? "won" : "lost";
    row.profit = profit;
    row.confirmed = confirmed;
    if (hooks.trade) hooks.trade(Object.assign({}, row));
  }

  // ---------- Balance ----------
  let balVersion = 0;   // bumped on every local adjustment
  function adjustBalance(delta) { balVersion++; if (bal.value !== null) bal.value = round2(bal.value + delta); }
  async function refreshBalance() {
    if (!deps.balance) return;
    const v0 = balVersion;
    try {
      const v = await deps.balance();
      // If a buy/settlement was booked while this read was in flight, the reply may or may not include it, so it is
      // ignored (the next read corrects it). The first read (value still unknown) is always accepted.
      if (bal.value !== null && v0 !== balVersion) return;
      if (v !== null && v !== undefined && !isNaN(Number(v))) { bal.value = Number(v); emitState(); }
    } catch (_) { /* kept as is */ }
  }

  // Blocks that stop the whole bot (kind "stop"): stop-loss safety and balance.
  function purchaseBlock(stake, count) {
    if (cfg.hardStop && round2(totals().profit - stake) < -cfg.sl) {
      return { kind: "stop", msg: "Next stake " + stake.toFixed(2) + " could take the loss past the stop loss (" + cfg.sl + "). Stopped." };
    }
    if (bal.value === null) return { kind: "stop", msg: "Could not read the account balance, so no trade was placed. Stopped." };
    if (bal.value + 1e-9 < stake * count) {
      return { kind: "stop", msg: "Insufficient balance for this trade (" + bal.value.toFixed(2) + " available, " + (stake * count).toFixed(2) + " needed). Stopped." };
    }
    return null;
  }
  // Blocks that only end the current recovery cycle (kind "limit"), then the stop checks above.
  function recBlock(leg, stake) {
    if (leg.trades >= cfg.maxRec) return { kind: "limit", msg: "Maximum recovery trades (" + cfg.maxRec + ") reached." };
    if (stake > cfg.maxStake + 1e-9) {
      return { kind: "limit", msg: "Next recovery stake " + stake.toFixed(2) + " is above the maximum permitted stake (" + cfg.maxStake.toFixed(2) + ")." };
    }
    return purchaseBlock(stake, 1);
  }
  function limitHit() {
    const p = totals().profit;
    if (p >= cfg.tp) return "Take profit reached (" + p.toFixed(2) + "). Stopped.";
    if (p <= -cfg.sl) return "Stop loss reached (" + p.toFixed(2) + "). Stopped.";
    return null;
  }

  // ---------- Connection resilience (same approach as the Sniper engines) ----------
  const RECONNECT_WAIT_MS = cfg.reconnectWaitMs || 180000;
  const isOpen = () => (deps.isOpen ? deps.isOpen() : true);
  const socketId = () => (deps.socketId ? deps.socketId() : null);
  const NOT_SENT = /Still in CONNECTING|CLOSING|CLOSED|not open|not connected/i;
  const QUOTE_PROBLEM = /proposal|price|expired|invalid|not found/i;
  const NOT_READY = /wait|clos|settl|still|already|open|pending/i;
  function stopAbortError() { const e = new Error("Stopped"); e.stopAbort = true; return e; }

  function markDown() {
    if (reconnectNoticeOn) return;
    reconnectNoticeOn = true;
    log("Connection lost - waiting to reconnect. The bot resumes by itself.");
    emitState();
  }
  function markUp() {
    if (!reconnectNoticeOn) return;
    reconnectNoticeOn = false;
    log("Reconnected - bot resumed.");
    emitState();
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
    await pause(400);
    markUp();
  }

  // ctx is given for BUY requests only: { contract, stake }.
  async function sendSafe(req, ctx) {
    const sentEpoch = Math.floor(Date.now() / 1000);
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      await waitForConnection();
      if (ctx && !running) throw stopAbortError();                 // Stop was pressed before the buy left
      try {
        return await deps.send(req);
      } catch (e) {
        lastErr = e;
        const msg = (e && e.message) || "";
        if ((e && e.notSent) || NOT_SENT.test(msg)) continue;      // never left the browser: send again
        if (e && (e.connectionLost || e.timeout)) {
          if (!ctx) continue;                                      // a lost price request is harmless
          const found = await findPurchasedContract(ctx, sentEpoch);   // did the buy go through?
          if (found) {
            log("Connection dropped while buying - the trade had gone through, carrying on with it.");
            return { buy: { contract_id: found } };
          }
          continue;                                                // confirmed NOT bought: try again
        }
        throw e;
      }
    }
    throw lastErr || new Error("Connection kept dropping");
  }

  // After a lost buy reply: look in Deriv's open positions and recent closed trades. Only when BOTH lists could be
  // read and neither has it do we treat the buy as "not placed" - so a buy is never repeated by mistake.
  async function findPurchasedContract(ctx, sentEpoch) {
    await waitForConnection();
    await pause(1500);
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

  // ---------- Proposals / cached quotes ----------
  // A live quote is kept ready for each trade the bot may need next, so a buy can go out the instant it is needed.
  function proposalReq(spec, stake) {
    return {
      proposal: 1, amount: stake, basis: "stake", contract_type: spec.contract, currency: cfg.currency,
      underlying_symbol: cfg.symbol, duration: spec.duration, duration_unit: "t", barrier: String(spec.barrier),
    };
  }
  const qKey = (spec, stake) => spec.contract + "|" + spec.barrier + "|" + stake + "|" + spec.duration;
  const quotes = new Map();
  let lastWanted = [];
  function openQuote(spec, stake) {
    const q = { latest: null, updatedAt: null, error: null, unsub: null, socket: socketId() };
    try {
      q.unsub = deps.subscribe(proposalReq(spec, stake), function (data) {
        if (data.error) { q.latest = null; q.error = data.error.message || "quote error"; return; }
        if (data.proposal) { q.latest = data.proposal; q.updatedAt = now(); q.error = null; }
      });
    } catch (_) { /* no cached quote: a fresh one is requested at buy time */ }
    return q;
  }
  function closeQuote(q) { if (q && q.unsub) { try { q.unsub(); } catch (_) {} } }
  function setQuotes(items) {
    lastWanted = items;
    const want = new Set(items.map((x) => qKey(x.spec, x.stake)));
    quotes.forEach(function (q, k) { if (!want.has(k)) { closeQuote(q); quotes.delete(k); } });
    items.forEach(function (x) {
      const k = qKey(x.spec, x.stake);
      if (!quotes.has(k)) quotes.set(k, openQuote(x.spec, x.stake));
    });
  }
  function desiredQuotes() {
    if (!running || ended) return [];
    const out = [];
    if (rec) {
      if (rec.phase !== "open") out.push({ spec: recoverySpec(recoveryRuleOf(rec.side)), stake: recStake(rec) });
      else if (rec.phase === "open" && cfg.immediate) {
        const nx = round2(S * Math.pow(cfg.mult, rec.level + 1));   // the stake used if this trade loses
        if (rec.trades < cfg.maxRec && nx <= cfg.maxStake) out.push({ spec: recoverySpec(recoveryRuleOf(rec.side)), stake: nx });
      }
    } else if (entryBusy) {
      if (cfg.recoveryEnabled) {            // whichever side loses will need its recovery quote
        const nx = round2(S * Math.pow(cfg.mult, st.carry + 1));
        if (nx <= cfg.maxStake) [OVER, UNDER].forEach((r) => out.push({ spec: recoverySpec(recoveryRuleOf(r.side)), stake: nx }));
      }
    } else if (st.mode === "waiting") {
      [OVER, UNDER].forEach((r) => out.push({ spec: initialSpec(r), stake: S }));
    }
    return out;
  }
  const refreshQuotes = function () { setQuotes(desiredQuotes()); };

  // ---------- Buying ----------
  async function buyOne(spec, stake) {
    const parts = [];
    const key = qKey(spec, stake);
    const q = quotes.get(key);
    let cached = q && q.socket === socketId() ? q.latest : null;
    if (!cached) parts.push(q ? (q.error ? "quote error: " + q.error : "no quote had arrived yet") : "no quote prepared for this stake");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let proposal = cached;
        if (proposal) {
          parts.push("cached quote, " + ms(q.updatedAt, now()) + " old");
        } else {
          const tp = now();
          const res = await sendSafe(proposalReq(spec, stake));
          parts.push("fresh quote " + ms(tp, now()));
          if (!res.proposal) throw new Error((res.error && res.error.message) || "No price available for this trade.");
          proposal = res.proposal;
        }
        const tb = now();
        const r = await sendSafe({ buy: proposal.id, price: proposal.ask_price }, { contract: spec.contract, stake: stake });
        parts.push("buy " + ms(tb, now()));
        lastTrace = parts.join(" -> ");
        if (!r.buy || !r.buy.contract_id) throw new Error("Trade did not go through.");
        const used = quotes.get(key);           // a quote can only be used once
        if (used) { closeQuote(used); quotes.delete(key); }
        adjustBalance(-stake);
        return r;
      } catch (e) {
        if (e && e.stopAbort) { lastTrace = parts.join(" -> "); throw e; }
        const msg = (e && e.message) || "";
        parts.push("buy REJECTED (" + msg + ")");
        // A rejected buy created no contract, so one retry is safe.
        if (attempt === 0 && pendingFinal && NOT_READY.test(msg)) {
          const tw = now();
          await Promise.race([pendingFinal, pause(5000)]);
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

  // Returns { earlyLoss, final }. `final` resolves with the settled contract (Deriv's confirmed result).
  // `earlyLoss` (only when useEarly) resolves the moment an update shows the contract ended on a LOSING exit digit.
  // Re-subscribes by itself if the socket is rebuilt.
  function watchContract(contractId, spec, useEarly) {
    let unsub = null, offRe = null, finished = false, earlySent = false, subSocket = null;
    let resolveEarly, resolveFinal, rejectFinal;
    const earlyLoss = new Promise((res) => { resolveEarly = res; });
    const final = new Promise((res, rej) => { resolveFinal = res; rejectFinal = rej; });
    final.catch(noop);   // the owner handles errors; this only silences "unhandled rejection" noise
    const cleanup = function () {
      finished = true;
      if (unsub) { try { unsub(); } catch (_) {} }
      if (offRe) offRe();
    };
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
          if (useEarly && !earlyDisabled && !earlySent && (poc.is_expired || settled)) {
            const d = exitDigitOf(poc);
            if (d !== null && specLoses(spec, d)) { earlySent = true; resolveEarly({ early: true }); }
          }
          if (settled) { cleanup(); resolveFinal(poc); }
        });
        subSocket = sid;
      } catch (e) {
        unsub = null; subSocket = null;      // socket not ready: try again as soon as it is back
        waitForConnection().then(
          function () { if (!finished) open(); },
          function (err) { if (!finished) { cleanup(); rejectFinal(err); } });
      }
    };
    open();
    offRe = deps.onReconnect ? deps.onReconnect(open) : null;
    return { earlyLoss: earlyLoss, final: final };
  }

  // One more contract is now open / confirmed. Keeps count so the bot only ends once everything is settled.
  function trackOpen(watch, contractId) {
    trackedContracts.add(String(contractId));
    inflight++;
    const finish = function () {
      inflight--;
      // Background re-sync with Deriv's real balance: a moment later, once this settlement is fully booked and only if
      // nothing new has been bought meanwhile (so the read can never overlap a buy or a settlement).
      if (inflight === 0 && running) setTimeout(function () { if (!ended && inflight === 0 && running) refreshBalance(); }, 150);
      emitState();
      maybeEnd();
    };
    watch.final.then(finish, finish);
  }

  // ---------- Ending ----------
  function maybeEnd() { if (!running && !ended && activeOps === 0 && inflight === 0) end(); }
  function stopWith(msg) { if (msg) log(msg); running = false; }
  function end() {
    if (ended) return;
    ended = true;
    running = false;
    if (offTick) offTick();
    if (offReconnect) offReconnect();
    if (watchdog) clearInterval(watchdog);
    reconnectNoticeOn = false;
    setQuotes([]);
    rec = null; recQueue.length = 0;
    setMode("stopped");
    log("Bot stopped.");
    emitState();
    if (hooks.finished) hooks.finished();
    resolveDone();
  }

  // ---------- Recovery legs ----------
  function newLeg(side) {
    const r = recoveryRuleOf(side);
    return { side: side, contract: r.contract, barrier: r.recBarrier, label: r.name + " " + r.recBarrier,
      level: 0, trades: 0, patternNeed: PAT, confirmNeed: cfg.recConfirm, strength: false, phase: "winning", patCount: 0, count: 0, placing: false, openStake: 0, cycleWon: false };
  }
  // Preferred winning digits for the reverse recovery contract.
  const qualifies = (leg, d) => !specLoses(recoverySpec(recoveryRuleOf(leg.side)), d);

  // Take the next waiting recovery leg, or go back to waiting for a fresh entry.
  function activateNextOrWait() {
    if (!running) { rec = null; recQueue.length = 0; maybeEnd(); emitState(); return; }
    if (recQueue.length) {
      rec = recQueue.shift();
      rec.level = st.carry + 1;      // the loss that created this leg counts as one martingale step
      rec.strength = false; rec.patternNeed = PAT; rec.confirmNeed = cfg.recConfirm;
      rec.phase = "winning"; rec.patCount = 0; rec.count = 0; rec.placing = false;
      setMode("recovery");
      const first = recStake(rec);
      log("PH Reverse recovery for " + rec.label + ": waiting for " + rec.patternNeed + " consecutive winning digit(s), then " + rec.confirmNeed + " consecutive losing/confirming digit(s). First stake " + first.toFixed(2) + ".");
      if (first > cfg.maxStake + 1e-9) {    // no point waiting for digits when the first stake is not allowed
        endLeg(rec, "limit", "First recovery stake " + first.toFixed(2) + " is above the maximum permitted stake (" + cfg.maxStake.toFixed(2) + ").");
        return;
      }
    } else {
      rec = null;
      setMode("waiting");
      st.entryCount = 0;
    }
    refreshQuotes();
    emitState();
  }

  // why: "won" | "limit" | "stop"
  function endLeg(leg, why, msg) {
    leg.phase = "done";
    if (why === "won") {
      st.carry = 0;
      log("Recovery won - martingale reset.");
    } else if (why === "limit") {
      log(msg + " Recovery for " + leg.label + " stopped.");
      if (cfg.afterLimit === "stop") { stopWith("Stopped (recovery limit reached)."); }
      else if (cfg.afterLimit === "reset") { st.carry = 0; log("Martingale reset - starting again at the initial stake."); }
      else { st.carry = leg.level; log("Martingale level " + leg.level + " kept (it only resets when a recovery trade wins)."); }
    } else if (msg) {
      stopWith(msg);
    }
    rec = null;
    activateNextOrWait();
  }

  // ---------- Entry: Over 3 + Under 6 at the same time ----------
  async function entryCycle() {
    entryBusy = true; activeOps++;
    st.entryCount = 0;
    setMode("entry");
    // NOTE: quotes are deliberately NOT refreshed here - the two entry quotes prepared while waiting are about to be used.
    emitState();
    try {
      if (bal.value === null) await refreshBalance();
      const block = purchaseBlock(S, 2);
      if (block) { stopWith(block.msg); return; }
      const specs = [initialSpec(OVER), initialSpec(UNDER)];
      const t0 = now();
      const tries = await Promise.all(specs.map((spec) =>
        buyOne(spec, S).then((r) => ({ ok: true, spec: spec, r: r }), (e) => ({ ok: false, spec: spec, e: e }))));
      const bought = tries.filter((x) => x.ok);
      tries.filter((x) => !x.ok).forEach(function (x) {
        if (x.e && x.e.stopAbort) return;
        stopWith("Error: could not buy " + x.spec.label + " (" + ((x.e && x.e.message) || "unknown") + ") - bot stopped.");
      });
      if (!bought.length) return;
      if (bought.length === 1) stopWith("Only one of the two entry contracts was bought - the bot will stop once it settles.");
      log("timing: both entry contracts bought in " + ms(t0, now()) + " [" + lastTrace + "]");
      refreshQuotes();    // now prepare the recovery quotes for whichever side loses

      const results = await Promise.all(bought.map(async function (x) {
        const cid = x.r.buy.contract_id;
        const row = addRow(x.spec, "Entry", S, cid, 0);
        const watch = watchContract(cid, x.spec, false);   // entry results are only ever taken from Deriv's confirmed result
        trackOpen(watch, cid);
        emitState();
        const poc = await watch.final;
        const won = wonOf(poc);
        setRow(row, won, Number(poc.profit) || 0, true);
        return { spec: x.spec, won: won };
      }));

      // ----- outcome of the entry -----
      const lost = results.filter((r) => !r.won);
      if (results.length === 2 && lost.length === 0) {
        st.carry = 0;
        log("Both contracts won - martingale reset.");
      } else if (lost.length) {
        log(lost.map((r) => r.spec.label).join(" and ") + " lost; the winning contract is not recovered.");
      }
      const hit = limitHit();
      if (hit) { stopWith(hit); }
      else if (running && lost.length) {
        if (cfg.recoveryEnabled) lost.forEach((r) => recQueue.push(newLeg(r.spec.side)));
        else log("Recovery is switched off - the loss is recorded and the bot goes back to waiting for the next entry.");
      }
    } catch (e) {
      if (!(e && e.stopAbort)) stopWith("Error: " + ((e && e.message) || "unknown") + " - bot stopped.");
    } finally {
      entryBusy = false; activeOps--;
      if (!rec) activateNextOrWait();
      emitState();
      maybeEnd();
    }
  }

  // ---------- Recovery: one losing side, same contract, same barrier ----------
  function reconcile(row, poc, leg) {
    // The early (exit-digit) read said LOSS; Deriv's confirmed result replaces it here.
    const actual = Number(poc.profit) || 0;
    if (wonOf(poc)) {
      earlyDisabled = true;
      leg.cycleWon = true;      // the cycle really did win; the trade already placed is the last one
      setRow(row, true, actual, true);
      log("WARNING: that recovery trade was actually a WIN, so the early reading was wrong. It is switched off for the rest of this run, and the recovery cycle ends after the trade already placed.");
    } else {
      setRow(row, false, actual, true);
    }
    const hit = limitHit();
    if (hit && running) stopWith(hit);
    emitState();
    maybeEnd();
  }

  async function runRecovery(leg) {
    activeOps++;
    let nextBuy = null, lossSeenAt = null;
    try {
      for (;;) {
        leg.phase = "open";
        setMode("recovery");
        const stake = recStake(leg);
        const spec = recoverySpec(recoveryRuleOf(leg.side));
        if (!nextBuy) {
          if (bal.value === null) await refreshBalance();
          const block = recBlock(leg, stake);
          if (block) { return endLeg(leg, block.kind, block.msg); }
        }
        leg.openStake = stake;
        emitState();
        const bought = await (nextBuy ? nextBuy.promise : buyOne(spec, stake));
        nextBuy = null;
        const confirmedAt = now();
        leg.trades++;
        const cid = bought.buy.contract_id;
        const row = addRow(spec, "Recovery", stake, cid, leg.level);
        if (lossSeenAt !== null) { log("timing: loss seen -> next recovery buy confirmed in " + ms(lossSeenAt, confirmedAt) + " [" + lastTrace + "]"); lossSeenAt = null; }
        const useEarly = cfg.immediate && cfg.fastRecovery && !earlyDisabled;
        const watch = watchContract(cid, spec, useEarly);
        trackOpen(watch, cid);
        refreshQuotes();          // quote for the stake we would use after a loss
        emitState();

        const first = await Promise.race([watch.earlyLoss, watch.final]);
        const seenAt = now();
        let won;
        if (first && first.early) {
          won = false;
          setRow(row, false, -stake, false);       // ESTIMATED until Deriv confirms (reconcile below)
          const fp = watch.final.then(
            function (poc) { if (pendingFinal === fp) pendingFinal = null; log("timing: Deriv's confirmed result came " + ms(seenAt, now()) + " after the loss was read from the exit digit."); reconcile(row, poc, leg); },
            function () { if (pendingFinal === fp) pendingFinal = null; });
          pendingFinal = fp;
        } else {
          won = wonOf(first);
          setRow(row, won, Number(first.profit) || 0, true);
        }

        if (won || leg.cycleWon) { return endLeg(leg, "won"); }

        // ----- the recovery trade lost: martingale goes up, never down -----
        leg.level++;
        const hit = limitHit();
        if (hit) { return endLeg(leg, "stop", hit); }
        if (!running) { return endLeg(leg, "stop"); }
        // The first recovery uses the original pattern. Once that recovery loses,
        // all later pattern-gated attempts use the Recovery strength settings.
        if (leg.trades >= 1) { leg.strength = true; leg.patternNeed = Math.max(0, Math.floor(cfg.recStrengthPattern || 0)); leg.confirmNeed = Math.max(1, Math.floor(cfg.recStrengthConfirm || 1)); }
        const nStake = recStake(leg);
        const block = recBlock(leg, nStake);
        if (block) { return endLeg(leg, block.kind, block.msg); }
        if (cfg.immediate) {
          // Straight away: the next buy goes out BEFORE any screen work, using the quote prepared while this trade was open.
          nextBuy = { promise: buyOne(spec, nStake) };
          lossSeenAt = seenAt;
          emitState();
          continue;
        }
        // Immediate recovery is off: restart the reverse two-stage pattern for the next trade.
        leg.phase = "winning"; leg.patCount = 0; leg.count = 0; leg.placing = false;
        log("Recovery trade lost - starting the " + (leg.strength ? "Recovery strength" : "original recovery") + " sequence again: " + leg.patternNeed + " consecutive winning digit(s), then " + leg.confirmNeed + " consecutive losing/confirming digit(s).");
        refreshQuotes();
        emitState();
        return;
      }
    } catch (e) {
      if (!(e && e.stopAbort)) stopWith("Error: " + ((e && e.message) || "unknown") + " - bot stopped.");
      if (rec === leg) { rec = null; recQueue.length = 0; }
      if (!running) maybeEnd();
    } finally {
      activeOps--;
      emitState();
      maybeEnd();
    }
  }

  // ---------- Ticks ----------
  offTick = deps.onTick(function (t) {
    if (ended || t.symbol !== cfg.symbol) return;
    const digit = Number(Number(t.quote).toFixed(cfg.pipDecimals).slice(-1));
    lastDigit = digit;
    if (hooks.tickDigit) hooks.tickDigit(digit);
    if (running) {
      if (rec) {
        if (rec.phase === "winning" && !rec.placing) {
          // Stage 1: require the configured consecutive digits that WIN the recovery contract.
          if (qualifies(rec, digit)) rec.patCount++;
          else rec.patCount = 0;
          if (rec.patCount >= rec.patternNeed) {
            rec.phase = "confirm"; rec.count = 0;
            log("Winning-digit pattern complete: " + rec.patternNeed + " in a row. Now waiting for " + rec.confirmNeed + " consecutive losing/confirming digit(s).");
          }
        } else if (rec.phase === "confirm" && !rec.placing) {
          // Stage 2: require consecutive digits that LOSE the recovery contract.
          if (specLoses(recoverySpec(recoveryRuleOf(rec.side)), digit)) {
            rec.count++;
            if (rec.count >= rec.confirmNeed) {
              // Start the purchase immediately from this tick callback; do not wait for another tick.
              rec.placing = true;
              runRecovery(rec);
            }
          } else {
            // A winning digit interrupts confirmation: reset both stages and begin a fresh winning streak
            // from the next tick, matching the configured two-stage sequence.
            rec.phase = "winning"; rec.patCount = 0; rec.count = 0;
          }
        }
      } else if (st.mode === "waiting" && !entryBusy && recQueue.length === 0) {
        // Entry confirmation: N digits in a row, none of them 4 or 5.
        if (SKIP.has(digit)) st.entryCount = 0; else st.entryCount++;
        if (st.entryCount >= cfg.nEntry) entryCycle();
      }
    }
    emitState();
  });

  // After a reconnect: ticks were missed (confirmation counts must be built from fresh digits) and the old price
  // quotes belonged to the old connection.
  offReconnect = deps.onReconnect ? deps.onReconnect(function () {
    st.entryCount = 0;
    if (rec && rec.phase === "winning") rec.patCount = 0;
    if (rec && rec.phase === "confirm") rec.count = 0;
    quotes.clear();
    setQuotes(lastWanted);
    refreshBalance();
    emitState();
  }) : null;

  watchdog = deps.isOpen ? setInterval(function () {
    if (ended) return;
    if (!isOpen()) markDown(); else if (reconnectNoticeOn) markUp();
  }, 500) : null;

  // ---------- Go ----------
  refreshQuotes();
  refreshBalance();
  emitState();
  log("Started: after " + cfg.nEntry + " digit(s) in a row with no 4 or 5, buy Over 3 + Under 6 (stake " + S.toFixed(2) + ", " + cfg.duration + " tick(s)). " +
      (cfg.recoveryEnabled
        ? "Recovery: Over 3 -> Under 5, Under 6 -> Over 4; wait for " + PAT + " winning digit(s), then " + cfg.recConfirm + " losing/confirming digit(s); " + (cfg.immediate ? "immediate" : "confirmed") + " re-buys, max " + cfg.maxRec + " trades."
        : "Recovery is off."));

  return {
    done: done,
    snapshot: snapshot,
    stop: function () {
      if (!running) return;
      running = false;
      recQueue.length = 0;
      setQuotes([]);
      if (rec && (rec.phase === "confirm" || rec.phase === "winning")) rec = null;
      log("Stop requested - no new trades. Waiting for any open contract to settle.");
      emitState();
      maybeEnd();
    },
  };
}

if (typeof module !== "undefined") module.exports = { startPHReverseEngine, PH_REVERSE_RULES };
