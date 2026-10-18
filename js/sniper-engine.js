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

  const st = { stake: cfg.stake, recovery: false, recCount: 0, profit: 0, trades: 0, wins: 0, window: [] };
  let running = true, busy = false, ended = false;
  let quote = null, offTick = null;
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

  // Watches a contract until it settles; re-subscribes if the socket is rebuilt.
  function waitForSettlement(contractId) {
    return new Promise(function (resolve, reject) {
      let unsub = null, finished = false, offRe = null;
      const finish = function (fn, v) {
        if (finished) return;
        finished = true;
        if (unsub) { try { unsub(); } catch (_) {} }
        if (offRe) offRe();
        fn(v);
      };
      const open = function () {
        if (unsub) { try { unsub(); } catch (_) {} }
        unsub = deps.subscribe({ proposal_open_contract: 1, contract_id: contractId }, function (data) {
          if (data.error) return finish(reject, new Error(data.error.message || "Could not watch the contract."));
          const poc = data.proposal_open_contract;
          if (!poc) return;
          if (poc.is_sold || (poc.status && poc.status !== "open")) finish(resolve, poc);
        });
      };
      open();
      offRe = deps.onReconnect ? deps.onReconnect(open) : null;
    });
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

  async function cycle() {
    busy = true;
    try {
      do {
        status(st.recovery ? "Recovery trade" : "Pattern trade");
        const stakeNow = st.stake;
        const bought = await buyContract(stakeNow);
        closeQuote(quote); // that quote is used up
        quote = null;
        // While this contract is open, get the quote for the stake we'd use after a loss.
        ensureQuote(round2(stakeNow * cfg.mult));
        if (hooks.bought) hooks.bought({ stake: stakeNow, contractId: bought.buy.contract_id });

        const poc = await waitForSettlement(bought.buy.contract_id);
        if (hooks.settled) hooks.settled();
        const profit = Number(poc.profit) || 0;
        const won = poc.status ? poc.status === "won" : profit > 0;
        st.trades++;
        st.profit = round2(st.profit + profit);

        if (won) {
          st.wins++; st.stake = cfg.stake; st.recovery = false; st.recCount = 0;
        } else {
          const wasRecovery = st.recovery;
          st.stake = round2(st.stake * cfg.mult); // martingale: only a win resets it
          if (wasRecovery) {
            st.recCount++;
            if (st.recCount >= cfg.maxRecovery) {
              st.recovery = false; st.recCount = 0;
              log("Recovery limit reached - waiting for the pattern again (stake kept).");
            }
          } else { st.recovery = true; st.recCount = 0; }
        }
        stats({ trades: st.trades, wins: st.wins, profit: st.profit, stake: st.stake });
        log((won ? "WON " : "LOST ") + profit.toFixed(2) + " | total " + st.profit.toFixed(2) + " | next stake " + st.stake.toFixed(2));

        if (st.profit >= cfg.tp) { log("Take profit reached. Stopped."); running = false; }
        else if (st.profit <= -cfg.sl) { log("Stop loss reached. Stopped."); running = false; }
        else ensureQuote(st.stake); // keep a live quote ready for whatever comes next
        // Recovery loop: buy again straight away, no waiting for a tick.
      } while (running && st.recovery);
    } catch (e) {
      log("Error: " + ((e && e.message) || "unknown") + " - bot stopped.");
      running = false;
    }
    busy = false;
    if (running) status("Waiting for pattern"); else end();
  }

  offTick = deps.onTick(function (t) {
    if (ended || t.symbol !== cfg.symbol) return;
    const digit = Number(Number(t.quote).toFixed(cfg.pipDecimals).slice(-1));
    st.window.push(digit);
    if (st.window.length > cfg.nDigits) st.window.shift();
    if (hooks.tickDigit) hooks.tickDigit(digit);
    if (running && !busy && patternMet()) cycle();
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
