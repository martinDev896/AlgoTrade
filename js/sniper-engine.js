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

  const st = { stake: cfg.stake, recovery: false, recCount: 0, profit: 0, trades: 0, wins: 0, window: [] };
  let running = true, busy = false, ended = false;
  let quote = null, offTick = null;
  let earlyDisabled = false;
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
    const q = { stake: stake, latest: null, unsub: null };
    try {
      q.unsub = deps.subscribe(proposalReq(stake), function (data) {
        if (data.error) { q.latest = null; return; }
        if (data.proposal) q.latest = data.proposal;
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

  async function buyContract(stake) {
    const cached = quote && quote.stake === stake ? quote.latest : null;
    if (cached) {
      try {
        const r = await deps.send({ buy: cached.id, price: cached.ask_price });
        if (r.buy && r.buy.contract_id) return r;
      } catch (e) {
        // Only fall back to a fresh quote when the failure is about the
        // quote itself — never retry an ambiguous failure (avoids a double buy).
        if (!/proposal|price|expired|invalid|not found/i.test((e && e.message) || "")) throw e;
      }
    }
    const res = await deps.send(proposalReq(stake));
    if (!res.proposal) throw new Error((res.error && res.error.message) || "No price available for this trade.");
    const r = await deps.send({ buy: res.proposal.id, price: res.proposal.ask_price });
    if (!r.buy || !r.buy.contract_id) throw new Error("Trade did not go through.");
    return r;
  }

  // ---------- Contract watching ----------
  const wonOf = (poc) => (poc.status ? poc.status === "won" : Number(poc.profit) > 0);

  // Last digit of the exit tick, read from the contract update itself.
  function exitDigitOf(poc) {
    const shown = poc.exit_tick_display_value;
    if (shown !== undefined && shown !== null && String(shown) !== "") return Number(String(shown).slice(-1));
    if (poc.exit_tick !== undefined && poc.exit_tick !== null) return Number(Number(poc.exit_tick).toFixed(cfg.pipDecimals).slice(-1));
    return null;
  }
  const digitLoses = (d) => (cfg.contract === "DIGITOVER" ? !(d > cfg.prediction) : !(d < cfg.prediction));

  // Returns { earlyLoss, final }:
  //   earlyLoss resolves the moment an update shows the contract has ended on a LOSING digit;
  //   final resolves with the settled contract (is_sold / status no longer "open").
  // Re-subscribes if the socket is rebuilt.
  function watchContract(contractId) {
    let unsub = null, offRe = null, finished = false, earlySent = false;
    let resolveEarly, resolveFinal, rejectFinal;
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
        if (!earlyDisabled && !earlySent && (poc.is_expired || settled)) {
          const d = exitDigitOf(poc);
          if (d !== null && digitLoses(d)) { earlySent = true; resolveEarly({ early: true }); }
        }
        if (settled) { cleanup(); resolveFinal(poc); }
      });
    };
    open();
    offRe = deps.onReconnect ? deps.onReconnect(open) : null;
    return { earlyLoss: earlyLoss, final: final };
  }

  function end() {
    if (ended) return;
    ended = true;
    running = false;
    if (offTick) offTick();
    closeQuote(quote);
    quote = null;
    status("Stopped");
    if (hooks.finished) hooks.finished();
    resolveDone();
  }

  const patternMet = () =>
    st.window.length === cfg.nDigits &&
    st.window.every((d) => (cfg.compare === "GTE" ? d >= cfg.threshold : d <= cfg.threshold));

  function pushStats() {
    stats({ trades: st.trades, wins: st.wins, profit: st.profit, stake: st.stake });
  }
  function limitHit() {
    if (st.profit >= cfg.tp) return "Take profit reached. Stopped.";
    if (st.profit <= -cfg.sl) return "Stop loss reached. Stopped.";
    return null;
  }

  // Applies one trade's result to the martingale / recovery state.
  function applyOutcome(won, profit) {
    st.trades++;
    st.profit = round2(st.profit + profit);
    if (won) {
      st.wins++; st.stake = cfg.stake; st.recovery = false; st.recCount = 0;
      return null;
    }
    const wasRecovery = st.recovery;
    st.stake = round2(st.stake * cfg.mult); // martingale: only a win resets it
    if (wasRecovery) {
      st.recCount++;
      if (st.recCount >= cfg.maxRecovery) {
        st.recovery = false; st.recCount = 0;
        return "Recovery limit reached - waiting for the pattern again (stake kept).";
      }
    } else { st.recovery = true; st.recCount = 0; }
    return null;
  }

  // The early (exit-digit) read said LOSS; this checks it against Deriv's final result.
  function reconcile(poc, stakeAtTrade, seenAt) {
    const actual = Number(poc.profit) || 0;
    log("timing: Deriv's final 'sold' update came " + ms(seenAt, now()) + " after the loss was seen from the exit tick.");
    if (wonOf(poc)) {
      earlyDisabled = true;
      st.wins++;
      st.profit = round2(st.profit + actual + stakeAtTrade); // replace the assumed loss with the real result
      log("WARNING: that trade was actually a WIN. Early reading switched off for the rest of this run.");
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
    let lossSeenAt = null;
    try {
      do {
        status(st.recovery ? "Recovery trade" : "Pattern trade");
        const stakeNow = st.stake;
        const sentAt = nextBuy ? nextBuy.sentAt : now();
        const bought = await (nextBuy ? nextBuy.promise : buyContract(stakeNow));
        nextBuy = null;
        const confirmedAt = now();
        log(lossSeenAt !== null
          ? "timing: loss seen -> next buy confirmed in " + ms(lossSeenAt, confirmedAt) + " (request took " + ms(sentAt, confirmedAt) + ")."
          : (tickAt !== null ? "timing: pattern tick -> buy confirmed in " + ms(tickAt, confirmedAt) + "." : ""));
        tickAt = null;
        lossSeenAt = null;

        closeQuote(quote); // that quote is used up
        quote = null;
        // While this contract is open, get the quote for the stake we'd use after a loss.
        ensureQuote(round2(stakeNow * cfg.mult));
        if (hooks.bought) hooks.bought({ stake: stakeNow, contractId: bought.buy.contract_id });

        const watch = watchContract(bought.buy.contract_id);
        const first = await Promise.race([watch.earlyLoss, watch.final]);
        const seenAt = now();
        let won, profit, provisional = false;
        if (first && first.early) {
          won = false; profit = -stakeNow; provisional = true;
          watch.final.then(function (poc) { reconcile(poc, stakeNow, seenAt); }, function () {});
        } else {
          won = wonOf(first);
          profit = Number(first.profit) || 0;
        }

        const note = applyOutcome(won, profit);
        const hit = limitHit();
        if (hit) running = false;

        // Start the next buy BEFORE any screen/log work, so nothing delays it.
        if (running && st.recovery) {
          nextBuy = { promise: buyContract(st.stake), sentAt: now() };
          lossSeenAt = seenAt;
        }

        if (hooks.settled) hooks.settled();
        pushStats();
        log((won ? "WON " : "LOST ") + profit.toFixed(2) + (provisional ? " (from exit tick)" : "") +
            " | total " + st.profit.toFixed(2) + " | next stake " + st.stake.toFixed(2));
        if (note) log(note);
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
