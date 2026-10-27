// ==========================================================
// AlgoTrade — sniper-evenodd.js
// The Sniper Trader tab's bot picker (two cards) and the
// "Even/Odd Sniper Trader" interface.
//
// Same rules as sniper-trader.js: it never touches auth.js / api.js,
// it only CALLS derivAPI.send / derivAPI.subscribe, live ticks come from
// the shared "algotrade:tick" broadcast, and the market is the app's single
// shared selection (the dropdown under the digit widget).
//
// Only ONE sniper bot can run at a time. The two bots tell each other when
// they start/stop through the "algotrade:sniper-run-state" event.
// ==========================================================
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tabEl = $("tab-sniper-trader");
  if (!tabEl || !$("sn-eo-card")) return;

  const el = {
    pickOU: $("sn-pick-ou"), pickEO: $("sn-pick-eo"), cardOU: $("sn-ou-card"), cardEO: $("sn-eo-card"),
    banner: $("eo-banner"), marketLine: $("eo-market-line"), hint: $("eo-hint"),
    mode: $("eo-mode"), duration: $("eo-duration"), nDigits: $("eo-ndigits"), maxRec: $("eo-maxrec"),
    stake: $("eo-stake"), mult: $("eo-mult"), tp: $("eo-tp"), sl: $("eo-sl"), maxTrades: $("eo-maxtrades"),
    hardStop: $("eo-hardstop"), fastRead: $("eo-fastread"),
    run: $("eo-run"), stop: $("eo-stop"),
    status: $("eo-status"), last: $("eo-last"), next: $("eo-next"), profit: $("eo-profit"),
    log: $("eo-log"),
  };

  let session = null;            // the running Even/Odd engine, if any
  let otherRunning = false;      // the Over/Under bot is running
  const running = { overunder: false, evenodd: false };

  // ---------- helpers ----------
  function decimalPlacesFor(pipSize) {
    const str = String(pipSize);
    const dot = str.indexOf(".");
    return dot === -1 ? 0 : str.length - dot - 1;
  }
  function symbolMeta(symbol) { return (AppState.allSymbols || []).find((s) => s.symbol === symbol) || null; }
  const isSynthetic = (meta) => !!meta && meta.marketCode === "synthetic_index";
  function activeAccount() { return AppState.accounts.find((a) => a.account_id === AppState.activeAccountId) || null; }
  function activeCurrency() { const a = activeAccount(); return a ? a.currency : "USD"; }
  // On-screen notice: only the latest IMPORTANT message is shown (errors, limits reached, warnings).
  // The detailed trade log (timings, every trade) stays in the browser console (F12) for troubleshooting.
  const QUIET = /^(timing:|speed:|debug |Pattern:|Started:|Stop requested|Fast loss reading ON|WON |LOST |Bot stopped)/;
  function log(text) {
    console.debug("[Even/Odd bot] " + text);
    if (QUIET.test(text)) return;
    const bad = /^Error|stop loss|WARNING|Check settings|could take the loss|Not connected|Choose a synthetic|Account changed|is running/i.test(text);
    const good = /Take profit/i.test(text);
    el.log.textContent = text;
    el.log.className = "sniper-msg" + (bad ? " bad" : good ? " good" : "");
  }
  function clearMsg() { el.log.textContent = ""; el.log.className = "sniper-msg hidden"; }

  const signed = (x) => (x > 0 ? "+" : "") + x.toFixed(2);
  const tone = (node, v) => { node.classList.toggle("sniper-pos", v > 0); node.classList.toggle("sniper-neg", v < 0); };
  let prevProfit = 0, prevTrades = 0;
  function paintStats(s) {
    el.profit.textContent = signed(s.profit);
    tone(el.profit, s.profit);
    if (s.trades > prevTrades) {                          // a trade just finished: show its result
      const d = Math.round((s.profit - prevProfit) * 100) / 100;
      el.last.textContent = "last trade " + signed(d);
      tone(el.last, d);
    }
    prevProfit = s.profit; prevTrades = s.trades;
    el.next.textContent = s.stake.toFixed(2);
  }
  function resetDash(stake) {
    prevProfit = 0; prevTrades = 0;
    el.profit.textContent = "0.00"; tone(el.profit, 0);
    el.last.textContent = ""; tone(el.last, 0);
    el.next.textContent = stake.toFixed(2);
  }
  function setStatus(text) {
    el.status.textContent = text;
    el.status.classList.toggle("running", !/^(Idle|Stopped)/.test(text));
  }
  const announce = (bot, on) => document.dispatchEvent(new CustomEvent("algotrade:sniper-run-state", { detail: { bot: bot, running: on } }));

  // ==========================================================
  // Bot picker: two cards side by side; clicking one shows its interface
  // ==========================================================
  const PICK_KEY = "algotrade.sniperBot";
  function showBot(bot) {
    const eo = bot === "evenodd";
    el.cardOU.classList.toggle("hidden", eo);
    el.cardEO.classList.toggle("hidden", !eo);
    el.pickOU.classList.toggle("active", !eo);
    el.pickEO.classList.toggle("active", eo);
    el.pickOU.setAttribute("aria-pressed", String(!eo));
    el.pickEO.setAttribute("aria-pressed", String(eo));
    try { localStorage.setItem(PICK_KEY, bot); } catch (_) { /* choice just isn't remembered */ }
  }
  el.pickOU.addEventListener("click", () => showBot("overunder"));
  el.pickEO.addEventListener("click", () => showBot("evenodd"));
  (function restore() {
    let saved = null;
    try { saved = localStorage.getItem(PICK_KEY); } catch (_) {}
    showBot(saved === "evenodd" ? "evenodd" : "overunder");
  })();

  // "Running" badge on each card + remember whether the other bot is running
  function paintBadges() {
    el.pickOU.querySelector(".sniper-pick-badge").classList.toggle("hidden", !running.overunder);
    el.pickEO.querySelector(".sniper-pick-badge").classList.toggle("hidden", !running.evenodd);
  }
  document.addEventListener("algotrade:sniper-run-state", (e) => {
    running[e.detail.bot] = !!e.detail.running;
    otherRunning = running.overunder;
    paintBadges();
    setRunningUI(!!session);
  });

  // ==========================================================
  // Settings -> config
  // ==========================================================
  function updateHint() {
    const n = el.nDigits.value || "3";
    const mode = el.mode.value;
    const odd = "<b>EVEN</b> after " + n + " odd digits in a row";
    const even = "<b>ODD</b> after " + n + " even digits in a row";
    el.hint.innerHTML = "Buys " + (mode === "even" ? odd : mode === "odd" ? even : odd + " and " + even) + ".";
  }
  [el.mode, el.nDigits].forEach((x) => x.addEventListener("input", updateHint));
  updateHint();

  function readConfig() {
    const meta = symbolMeta(AppState.selectedSymbol);
    if (!isSynthetic(meta)) { log("Choose a synthetic index in the market dropdown first (digits contracts only work on those)."); return null; }
    const num = (inp) => Number(inp.value);
    const cfg = {
      currency: activeCurrency(), symbol: meta.symbol, pipDecimals: decimalPlacesFor(meta.pipSize),
      mode: el.mode.value, duration: num(el.duration), nDigits: num(el.nDigits), maxRecovery: num(el.maxRec),
      stake: num(el.stake), mult: num(el.mult), tp: num(el.tp), sl: num(el.sl), maxTrades: num(el.maxTrades),
      hardStop: !!el.hardStop.checked, fastRead: !!el.fastRead.checked,
    };
    let err = null;
    if (!(cfg.stake >= 0.35)) err = "Stake must be at least 0.35.";
    else if (!Number.isInteger(cfg.nDigits) || cfg.nDigits < 2 || cfg.nDigits > 10) err = "Digits in a row must be a whole number from 2 to 10.";
    else if (!Number.isInteger(cfg.duration) || cfg.duration < 1 || cfg.duration > 10) err = "Duration must be a whole number of ticks from 1 to 10.";
    else if (!Number.isInteger(cfg.maxRecovery) || cfg.maxRecovery < 0) err = "Max recovery trades must be 0 or more (0 = no recovery).";
    else if (!(cfg.mult >= 1)) err = "Multiplier must be 1 or more.";
    else if (!(cfg.tp > 0) || !(cfg.sl > 0)) err = "Take profit and stop loss must be above 0.";
    else if (!Number.isInteger(cfg.maxTrades) || cfg.maxTrades < 0) err = "Max trades must be 0 or more (0 = no limit).";
    else if (cfg.hardStop && cfg.stake > cfg.sl) err = "Stake is larger than the stop loss.";
    if (err) { log("Check settings: " + err); return null; }
    return cfg;
  }

  // ==========================================================
  // Run / Stop
  // ==========================================================
  const deps = {
    send: (req) => derivAPI.send(req),
    subscribe: (req, cb) => derivAPI.subscribe(req, cb),
    onTick: (fn) => {
      const h = (e) => fn(e.detail);
      document.addEventListener("algotrade:tick", h);
      return () => document.removeEventListener("algotrade:tick", h);
    },
    onReconnect: (fn) => {
      const h = () => fn();
      document.addEventListener("algotrade:reconnected", h);
      return () => document.removeEventListener("algotrade:reconnected", h);
    },
  };

  function setRunningUI(on) {
    el.run.disabled = on || otherRunning;
    el.run.title = otherRunning && !on ? "The Over/Under bot is running. Stop it first." : "";
    el.stop.disabled = !on;
    [el.mode, el.duration, el.nDigits, el.maxRec, el.stake, el.mult, el.tp, el.sl, el.maxTrades, el.hardStop, el.fastRead]
      .forEach((x) => { x.disabled = on; });
    // The shared market dropdown is locked while ANY sniper bot is running.
    const lock = on || otherRunning;
    const sel = $("sn-market-select");
    if (sel && on) { sel.disabled = true; sel.title = "Stop the bot to change market"; }
    else if (sel && !lock) { sel.disabled = false; sel.title = ""; }
  }

  const WIN_DIGITS = { DIGITEVEN: [0, 2, 4, 6, 8], DIGITODD: [1, 3, 5, 7, 9] };
  const widget = (detail) => document.dispatchEvent(new CustomEvent("algotrade:sniper-contract", { detail: detail }));

  el.run.addEventListener("click", () => {
    if (session) return;
    if (otherRunning) { log("The Over/Under bot is running. Stop it first."); return; }
    if (!derivAPI.ws || derivAPI.ws.readyState !== WebSocket.OPEN) { log("Not connected to Deriv yet."); return; }
    const cfg = readConfig();
    if (!cfg) return;
    const acct = activeAccount();
    if (acct && acct.account_type !== "demo") {
      if (!confirm("This bot will run on your REAL account and place real trades. Continue?")) return;
    }

    clearMsg();
    resetDash(cfg.stake);
    setRunningUI(true);
    session = startEvenOddEngine(deps, cfg, {
      log: log,
      status: setStatus,
      stats: paintStats,
      bought: (b) => widget({ open: true, winDigits: WIN_DIGITS[b.contract] || [] }),
      settled: () => widget({ open: false }),
      finished: () => { widget({ open: false }); session = null; announce("evenodd", false); setRunningUI(false); },
    });
    announce("evenodd", true);
  });

  el.stop.addEventListener("click", () => { if (session) session.stop(); });

  // Switching accounts rebuilds the session — never leave a bot running across that.
  document.addEventListener("algotrade:account-ready", () => {
    if (session) { log("Account changed - bot stopped."); session.stop(); }
    updateBanner();
  });

  function updateBanner() {
    const a = activeAccount();
    if (!a) { el.banner.textContent = ""; el.banner.className = "sniper-banner hidden"; return; }
    const demo = a.account_type === "demo";
    el.banner.textContent = demo ? "Demo account" : "Real account — trades use real money";
    el.banner.className = "sniper-banner " + (demo ? "sniper-banner-demo" : "sniper-banner-real");
  }
  function updateMarketLine() {
    const meta = symbolMeta(AppState.selectedSymbol);
    el.marketLine.textContent = isSynthetic(meta) ? meta.displayName : "No synthetic index selected";
  }

  document.addEventListener("algotrade:tab-shown", (e) => {
    if (e.detail.tab !== "sniper-trader") return;
    updateBanner(); updateMarketLine();
  });
  document.addEventListener("algotrade:symbol-selected", updateMarketLine);
  paintBadges();
})();
