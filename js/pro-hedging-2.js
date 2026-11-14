// ==========================================================
// AlgoTrade — pro-hedging-2.js
// UI for the "Pro Hedging 2" tab (Over 4 + Under 5 entry, Over 2-only
// recovery). The strategy itself lives in pro-hedging-2-engine.js (no DOM
// there); this file reads the settings, starts/stops the engine and paints
// the dashboard and trade history. Same layout and behaviour as the Pro
// Hedging tab; its ids are ph2-*, its styling classes are the shared ph-*.
//
// Shares with the other tabs:
//   - the app's ONE connection (derivAPI) and the ONE tick feed ("algotrade:tick")
//   - the ONE market selection (AppState.selectedSymbol / selectSymbol)
//   - the digit-distribution widget's tick window (localStorage + "algotrade:digit-window-changed")
//   - the one-bot-at-a-time rule ("algotrade:sniper-run-state"): this bot announces
//     itself as "prohedging2" and will not start while Over/Under, Even/Odd or
//     Pro Hedging is running (and the Pro Hedging tab will not start while this runs)
// ==========================================================

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tabEl = $("tab-pro-hedging-2");
  if (!tabEl) return;

  const el = {
    marketLine: $("ph2-market-line"), banner: $("ph2-banner"), marketSelect: $("ph2-market-select"),
    stake: $("ph2-stake"), duration: $("ph2-duration"), skipRun: $("ph2-skiprun"), skipBetween: $("ph2-skipbetween"), tp: $("ph2-tp"), sl: $("ph2-sl"),
    pattern: $("ph2-pattern"), confirm: $("ph2-confirm"), mult: $("ph2-mult"), maxRec: $("ph2-maxrec"), recDur: $("ph2-recdur"),
    maxStake: $("ph2-maxstake"), afterLimit: $("ph2-afterlimit"),
    recovery: $("ph2-recovery"), immediate: $("ph2-immediate"), fast: $("ph2-fast"), hardStop: $("ph2-hardstop"),
    preview: $("ph2-preview"), run: $("ph2-run"), stop: $("ph2-stop"), msg: $("ph2-msg"),
    mode: $("ph2-mode"), digitNow: $("ph2-digit-now"), digits: $("ph2-digits"),
    entryTxt: $("ph2-entry-txt"), entryBar: $("ph2-entry-bar"),
    patLabel: $("ph2-pat-label"), patTxt: $("ph2-pat-txt"), patBar: $("ph2-pat-bar"),
    recLabel: $("ph2-rec-label"), recTxt: $("ph2-rec-txt"), recBar: $("ph2-rec-bar"),
    profit: $("ph2-profit"), profitSub: $("ph2-profit-sub"), profitLimits: $("ph2-profit-limits"),
    tNext: $("ph2-t-next"), cBought: $("ph2-c-bought"), cWins: $("ph2-c-wins"), cLosses: $("ph2-c-losses"),
    histBody: $("ph2-hist-body"), histEmpty: $("ph2-hist-empty"),
    windowSelect: $("ph2-window"), widgetMarket: $("ph2-widget-market"),
    digitsLabel: $("ph2-digits-label"), digitsNote: $("ph2-digits-note"), digitsRow: $("ph2-digits-row"),
  };

  const SETTINGS = [el.marketSelect, el.widgetMarket, el.stake, el.duration, el.skipRun, el.skipBetween, el.tp, el.sl, el.pattern, el.confirm, el.mult, el.maxRec, el.recDur,
    el.maxStake, el.afterLimit, el.recovery, el.immediate, el.fast, el.hardStop];

  let session = null;
  let lastCfg = null;
  let otherRunning = null;            // name of another bot that is running, if any

  // ---------- helpers ----------
  const money = (x) => (x === null || x === undefined || isNaN(x) ? "—" : Number(x).toFixed(2));
  const signed = (x) => (x > 0 ? "+" : "") + Number(x).toFixed(2);
  function decimalPlacesFor(pipSize) { const s = String(pipSize), d = s.indexOf("."); return d === -1 ? 0 : s.length - d - 1; }
  function symbolMeta(symbol) { return (AppState.allSymbols || []).find((s) => s.symbol === symbol) || null; }
  function isSynthetic(meta) { return !!meta && meta.marketCode === "synthetic_index"; }
  function activeAccount() { return AppState.accounts.find((a) => a.account_id === AppState.activeAccountId) || null; }
  function activeCurrency() { const a = activeAccount(); return a ? a.currency : "USD"; }
  const tabIsVisible = () => !tabEl.classList.contains("hidden");

  // ---------- messages ----------
  // On screen: only the latest IMPORTANT message. Everything (timings, each step) goes to the console (F12).
  const QUIET = /^(timing:|Started:|Stop requested|Recovery for the losing|Pattern complete|Losing digit \d during confirmation|Recovery won|Both contracts won|Bot stopped|Reconnected|Connection lost)/;
  function log(text) {
    console.debug("[Pro Hedging 2] " + text);
    if (QUIET.test(text)) return;
    const bad = /^Error|stop loss|WARNING|Could not|Insufficient|could take the loss|Not connected|Choose a|Account changed|is running|Check settings|above the maximum|Maximum recovery/i.test(text);
    const good = /Take profit/i.test(text);
    setMsg(text, bad ? "bad" : good ? "good" : "");
  }
  function setMsg(text, kind) {
    el.msg.textContent = text;
    el.msg.className = "sniper-msg" + (kind ? " " + kind : "");
  }
  function clearMsg() { el.msg.textContent = ""; el.msg.className = "sniper-msg hidden"; }

  // ==========================================================
  // Digit distribution widget (same look + same math as the Sniper tab / digits.js)
  // ==========================================================
  // Ring colours, by rank of each digit's share of the window:
  //   most frequent = green, 2nd most = blue, 2nd least = yellow, least = red, everything in between = grey.
  const RISE_GREEN = "#2ECC8F", FALL_RED = "#FF5C5C";
  const RING_SECOND_MOST = "#4DA3FF", RING_SECOND_LEAST = "#F4C430", RING_MIDDLE = "#BFC5CE";
  // How many of the newest ticks the percentages use (shared with the Manual Trader and Sniper widgets).
  const WINDOW_CHOICES = [1000, 500, 250, 100, 50, 25];
  const WINDOW_KEY = "algotrade.digitWindow";
  let digitWindow = (function () {
    try {
      const saved = Number(localStorage.getItem(WINDOW_KEY));
      return WINDOW_CHOICES.indexOf(saved) !== -1 ? saved : 1000;
    } catch (_) { return 1000; }
  })();
  let history = [];              // last-digit values, most recent last (up to 1,000 kept)
  let historySymbol = null;      // which symbol `history` belongs to
  let cellRefs = [];

  function buildCells() {
    el.digitsRow.innerHTML = "";
    cellRefs = [];
    for (let d = 0; d <= 9; d++) {
      const cell = document.createElement("div");
      cell.className = "digit-cell";
      cell.innerHTML =
        '<svg viewBox="0 0 44 44" class="digit-ring">' +
        '<circle cx="22" cy="22" r="18" class="digit-ring-bg" />' +
        '<circle cx="22" cy="22" r="14" class="digit-fill" fill="none" />' +
        '<circle cx="22" cy="22" r="18" class="digit-ring-fg" transform="rotate(-90 22 22)" />' +
        '<text x="22" y="27" class="digit-ring-text">' + d + "</text></svg>" +
        '<span class="digit-pct">0.0%</span><span class="digit-cursor hidden"></span>';
      el.digitsRow.appendChild(cell);
      cellRefs.push({
        root: cell,
        ringFg: cell.querySelector(".digit-ring-fg"),
        fill: cell.querySelector(".digit-fill"),
        text: cell.querySelector(".digit-ring-text"),
        pct: cell.querySelector(".digit-pct"),
        cursor: cell.querySelector(".digit-cursor"),
      });
    }
  }

  function renderDigits() {
    if (cellRefs.length !== 10) buildCells();
    const shown = history.length > digitWindow ? history.slice(-digitWindow) : history;
    const total = shown.length || 1;
    const counts = new Array(10).fill(0);
    shown.forEach((d) => counts[d]++);
    // Rank by distinct counts (highest first), so digits that tie share a colour.
    const ranks = Array.from(new Set(counts)).sort((a, b) => b - a);
    const most = ranks[0], least = ranks[ranks.length - 1];
    const secondMost = ranks.length > 1 ? ranks[1] : null, secondLeast = ranks.length > 1 ? ranks[ranks.length - 2] : null;
    const ringColor = (c) => {
      if (ranks.length < 2) return RING_MIDDLE;        // nothing to tell apart (e.g. before any ticks have loaded)
      if (c === most) return RISE_GREEN;
      if (c === least) return FALL_RED;
      if (c === secondMost) return RING_SECOND_MOST;
      if (c === secondLeast) return RING_SECOND_LEAST;
      return RING_MIDDLE;
    };
    const last = history.length ? history[history.length - 1] : null;
    const circumference = 2 * Math.PI * 18;
    for (let d = 0; d <= 9; d++) {
      const ref = cellRefs[d];
      const pct = (counts[d] / total) * 100;
      ref.ringFg.setAttribute("stroke", ringColor(counts[d]));
      ref.ringFg.setAttribute("stroke-dasharray", circumference);
      ref.ringFg.setAttribute("stroke-dashoffset", circumference - (pct / 100) * circumference);
      ref.fill.setAttribute("fill", "none");
      ref.text.setAttribute("fill", "#1A1D22");
      ref.pct.textContent = pct.toFixed(1) + "%";
      ref.root.classList.toggle("digit-cell-active", last === d);
      ref.cursor.classList.toggle("hidden", last !== d);
    }
    paintDigits();
  }

  // Latest digit + the short strip (the last 20 digits, with 4 and 5 picked out in gold).
  function paintDigits() {
    const last = history.length ? history[history.length - 1] : null;
    el.digitNow.textContent = last === null ? "–" : String(last);
    el.digits.innerHTML = history.slice(-20).map((d) => '<span class="ph-dg' + (d <= 2 ? " lose" : "") + '">' + d + "</span>").join("");   // 0-2 = the digits that lose Over 2
  }

  async function loadHistoryFor(symbol) {
    const meta = symbolMeta(symbol);
    historySymbol = symbol;
    history = [];
    renderDigits();
    try {
      const res = await derivAPI.send({ ticks_history: symbol, style: "ticks", count: 1000, end: "latest" });
      const prices = (res.history && res.history.prices) || res.prices || [];
      if (historySymbol === symbol) {   // the market may have been switched meanwhile
        const places = decimalPlacesFor(meta ? meta.pipSize : 0.01);
        history = prices.map((p) => Number(Number(p).toFixed(places).slice(-1)));
        renderDigits();
      }
    } catch (err) {
      console.error("Pro Hedging 2 digits history failed:", err.message);
    }
  }

  // Live ticks: the shared broadcast from markets.js (no new subscription).
  document.addEventListener("algotrade:tick", (e) => {
    if (e.detail.symbol !== historySymbol) return;
    const meta = symbolMeta(historySymbol);
    const places = decimalPlacesFor(meta ? meta.pipSize : 0.01);
    history.push(Number(Number(e.detail.quote).toFixed(places).slice(-1)));
    if (history.length > 1000) history.shift();
    if (tabIsVisible()) renderDigits();
  });

  function setWindow(n, announce) {
    el.windowSelect.value = String(digitWindow);
    if (WINDOW_CHOICES.indexOf(n) === -1 || n === digitWindow) return;
    digitWindow = n;
    try { localStorage.setItem(WINDOW_KEY, String(n)); } catch (_) { /* setting just isn't remembered */ }
    el.windowSelect.value = String(n);
    syncSelection();            // refreshes the label
    renderDigits();
    if (announce) document.dispatchEvent(new CustomEvent("algotrade:digit-window-changed", { detail: { count: n } }));
  }
  el.windowSelect.value = String(digitWindow);
  el.windowSelect.addEventListener("change", () => setWindow(Number(el.windowSelect.value), true));
  document.addEventListener("algotrade:digit-window-changed", (e) => setWindow(e.detail.count, false));

  // ==========================================================
  // Market dropdowns (the settings one and the widget's one) — shared selection, same approach as the Sniper tab
  // ==========================================================
  function populateMarketSelect() {
    const synth = (AppState.allSymbols || []).filter(isSynthetic);
    [el.marketSelect, el.widgetMarket].forEach((sel) => {
      sel.innerHTML = "";
      const ph = document.createElement("option");
      ph.value = ""; ph.textContent = "Choose a synthetic index…";
      sel.appendChild(ph);
      synth.forEach((s) => {
        const o = document.createElement("option");
        o.value = s.symbol; o.textContent = s.displayName;
        sel.appendChild(o);
      });
    });
    syncSelection();
  }
  function syncSelection() {
    const meta = symbolMeta(AppState.selectedSymbol);
    const ok = isSynthetic(meta);
    el.marketSelect.value = ok ? meta.symbol : "";
    el.widgetMarket.value = ok ? meta.symbol : "";
    el.marketLine.textContent = ok ? meta.displayName : "No synthetic index selected";
    el.digitsNote.classList.toggle("hidden", ok);
    el.digitsLabel.textContent = "Last digit distribution — last " + digitWindow.toLocaleString("en-US") + " ticks" + (ok ? " · " + meta.displayName : "");
    if (ok && tabIsVisible() && historySymbol !== meta.symbol) loadHistoryFor(meta.symbol);
    if (!ok) { history = []; historySymbol = null; renderDigits(); }
  }
  function onMarketPicked(sel) {
    const symbol = sel.value;
    if (!symbol || session) return;
    const meta = symbolMeta(symbol);
    if (typeof selectSymbol === "function") selectSymbol(symbol, meta ? meta.displayName : symbol);
  }
  el.marketSelect.addEventListener("change", () => onMarketPicked(el.marketSelect));
  el.widgetMarket.addEventListener("change", () => onMarketPicked(el.widgetMarket));
  document.addEventListener("algotrade:symbol-selected", () => {
    if (!(AppState.allSymbols || []).length) return;
    if (el.marketSelect.options.length <= 1) populateMarketSelect(); else syncSelection();
  });
  // After a reconnect the tick feed resumes by itself (markets.js); reload the history to cover the gap.
  document.addEventListener("algotrade:reconnected", () => {
    if (historySymbol && tabIsVisible()) loadHistoryFor(historySymbol);
  });

  // ==========================================================
  // Recovery stake preview ("Recovery stake calculation")
  // ==========================================================
  function paintPreview() {
    const stake = Number(el.stake.value), mult = Number(el.mult.value), maxRec = Number(el.maxRec.value), maxStake = Number(el.maxStake.value);
    if (!(stake > 0) || !(mult >= 1) || !(maxRec >= 1)) { el.preview.textContent = ""; return; }
    if (!el.recovery.checked) { el.preview.textContent = "Recovery is off."; return; }
    const parts = [];
    for (let k = 1; k <= Math.min(maxRec, 12); k++) {
      const s = Math.round(stake * Math.pow(mult, k) * 100) / 100;
      parts.push(s > maxStake ? '<span class="over" title="Above the maximum stake - this trade would not be placed">' + s.toFixed(2) + "</span>" : "<b>" + s.toFixed(2) + "</b>");
    }
    el.preview.innerHTML = "Recovery stakes (initial " + stake.toFixed(2) + " × " + mult + " each loss): " + parts.join(" → ") + (maxRec > 12 ? " …" : "");
  }
  [el.stake, el.mult, el.maxRec, el.maxStake, el.recovery].forEach((x) => { x.addEventListener("input", paintPreview); x.addEventListener("change", paintPreview); });

  // ==========================================================
  // Settings -> config (validated before anything is traded)
  // ==========================================================
  function readConfig() {
    const meta = symbolMeta(AppState.selectedSymbol);
    if (!isSynthetic(meta)) { log("Choose a synthetic index in the market dropdown first (digits contracts only work on those)."); return null; }
    const num = (x) => Number(x.value);
    const int = (x) => Number.isInteger(num(x));
    const cfg = {
      currency: activeCurrency(), symbol: meta.symbol, pipDecimals: decimalPlacesFor(meta.pipSize),
      stake: num(el.stake), duration: num(el.duration), skipRun: num(el.skipRun), skipBetween: num(el.skipBetween), tp: num(el.tp), sl: num(el.sl),
      recoveryEnabled: !!el.recovery.checked, immediate: !!el.immediate.checked, fastRecovery: !!el.fast.checked, hardStop: !!el.hardStop.checked,
      recPattern: num(el.pattern), recConfirm: num(el.confirm), mult: num(el.mult), maxRec: num(el.maxRec), recDuration: num(el.recDur),
      maxStake: num(el.maxStake), afterLimit: el.afterLimit.value,
    };
    let err = null;
    if (!(cfg.stake >= 0.35)) err = "Initial stake must be at least 0.35.";
    else if (!int(el.duration) || cfg.duration < 1 || cfg.duration > 10) err = "Ticks must be a whole number from 1 to 10.";
    else if (!int(el.skipRun) || cfg.skipRun < 0 || cfg.skipRun > 20) err = "Skip ticks after Run must be a whole number from 0 to 20.";
    else if (!int(el.skipBetween) || cfg.skipBetween < 0 || cfg.skipBetween > 20) err = "Skip ticks between cycles must be a whole number from 0 to 20.";
    else if (!(cfg.tp > 0) || !(cfg.sl > 0)) err = "Take profit and stop loss must be above 0.";
    else if (!int(el.pattern) || cfg.recPattern < 0 || cfg.recPattern > 20) err = "Losing digits in a row must be a whole number from 0 to 20 (0 = off).";
    else if (!int(el.confirm) || cfg.recConfirm < 1 || cfg.recConfirm > 20) err = "Confirm digits must be a whole number from 1 to 20.";
    else if (!(cfg.mult >= 1 && cfg.mult <= 10)) err = "Multiplier must be between 1 and 10.";
    else if (!int(el.maxRec) || cfg.maxRec < 1 || cfg.maxRec > 30) err = "Max recovery trades must be a whole number from 1 to 30.";
    else if (!int(el.recDur) || cfg.recDuration < 1 || cfg.recDuration > 10) err = "Recovery ticks must be a whole number from 1 to 10.";
    else if (!(cfg.maxStake >= cfg.stake)) err = "Max stake cannot be below the initial stake.";
    else if (cfg.recoveryEnabled && Math.round(cfg.stake * cfg.mult * 100) / 100 > cfg.maxStake) err = "Max stake is below the first recovery stake (" + (Math.round(cfg.stake * cfg.mult * 100) / 100).toFixed(2) + "). Raise it or lower the multiplier.";
    if (err) { log("Check settings: " + err); return null; }
    return cfg;
  }

  // ==========================================================
  // Connection wrapper — same as the Sniper tab (tells the engine WHY a request failed)
  // ==========================================================
  const isOpen = () => !!derivAPI.ws && derivAPI.ws.readyState === WebSocket.OPEN;
  function sendWithDiagnosis(req) {
    return new Promise((resolve, reject) => {
      if (!isOpen()) { const e = new Error("Connection is not open"); e.notSent = true; reject(e); return; }
      const ws = derivAPI.ws;
      let done = false, watch = null, t = null;
      const finish = (fn, v) => { if (done) return; done = true; clearInterval(watch); clearTimeout(t); fn(v); };
      watch = setInterval(() => {
        if (derivAPI.ws !== ws || ws.readyState !== WebSocket.OPEN) { const e = new Error("Connection lost before the reply arrived"); e.connectionLost = true; finish(reject, e); }
      }, 200);
      t = setTimeout(() => { const e = new Error("No reply from Deriv within 20 seconds"); e.timeout = true; finish(reject, e); }, 20000);
      derivAPI.send(req).then((r) => finish(resolve, r), (e) => finish(reject, e));
    });
  }
  const deps = {
    isOpen: isOpen,
    socketId: () => derivAPI.ws,
    send: sendWithDiagnosis,
    subscribe: (req, cb) => derivAPI.subscribe(req, cb),
    balance: () => sendWithDiagnosis({ balance: 1 }).then((r) => (r && r.balance ? Number(r.balance.balance) : null)),
    onTick: (fn) => { const h = (e) => fn(e.detail); document.addEventListener("algotrade:tick", h); return () => document.removeEventListener("algotrade:tick", h); },
    onReconnect: (fn) => { const h = () => fn(); document.addEventListener("algotrade:reconnected", h); return () => document.removeEventListener("algotrade:reconnected", h); },
  };

  // ==========================================================
  // One sniper-style bot at a time
  // ==========================================================
  const running = {};
  document.addEventListener("algotrade:sniper-run-state", (e) => {
    if (e.detail.bot === "prohedging2") return;
    running[e.detail.bot] = !!e.detail.running;
    otherRunning = running.overunder ? "Over/Under" : running.evenodd ? "Even/Odd" : running.prohedging ? "Pro Hedging" : null;
    setRunningUI(!!session);
  });
  const announce = (on) => document.dispatchEvent(new CustomEvent("algotrade:sniper-run-state", { detail: { bot: "prohedging2", running: on } }));

  function setRunningUI(on) {
    el.run.disabled = on || !!otherRunning;
    el.run.title = otherRunning && !on ? "The " + otherRunning + " bot is running. Stop it first." : "";
    el.stop.disabled = !on;
    SETTINGS.forEach((x) => { x.disabled = on || ((x === el.marketSelect || x === el.widgetMarket) && !!otherRunning); });
    el.marketSelect.title = el.widgetMarket.title = on ? "Stop the running bot to change market" : "";
  }

  // ==========================================================
  // Dashboard
  // ==========================================================
  const MODE_TEXT = { waiting: "Waiting", entry: "Entry", recovery: "Recovery", stopped: "Stopped" };
  function setBar(barEl, count, need, state) {
    barEl.className = "ph-bar" + (state ? " " + state : "");
    barEl.firstElementChild.style.width = need > 0 ? Math.round((count / need) * 100) + "%" : "0%";
  }
  // Digit ranges shown next to the recovery bars, so it is always clear what counts.
  const isOverLeg = (label) => /^Over/.test(label || "");
  const losingRange = (label) => (isOverLeg(label) ? "0–2" : "7–9");        // digits that LOSE Over 2 / Under 7
  const winningRange = (label) => (isOverLeg(label) ? "3–9" : "0–6");       // digits that WIN Over 2 / Under 7

  function render(s) {
    // mode chip
    const stopped = s.mode === "stopped";
    el.mode.textContent = s.reconnecting ? "Reconnecting…" : MODE_TEXT[s.mode] || "Stopped";
    el.mode.className = "sniper-chip" + (s.reconnecting ? " warn" : !stopped ? " running" : "");

    // entry confirmation
    const waiting = s.mode === "waiting";
    if (!waiting) {
      el.entryTxt.textContent = s.mode === "entry" ? "buying" : "—";
      setBar(el.entryBar, s.mode === "entry" ? 1 : 0, 1, s.mode === "entry" ? "ready" : "idle");
    } else if (s.entrySkipLeft > 0) {
      el.entryTxt.textContent = (s.entrySkipNeed - s.entrySkipLeft) + " / " + s.entrySkipNeed + " skipped";
      setBar(el.entryBar, s.entrySkipNeed - s.entrySkipLeft, s.entrySkipNeed, "");
    } else {
      el.entryTxt.textContent = "buys next tick";
      setBar(el.entryBar, 1, 1, "ready");
    }

    // recovery pattern (losing digits) -> recovery confirmation
    const leg = s.recContract;
    if (s.patNeed === 0) {
      el.patLabel.textContent = "Recovery pattern (losing digits)";
      el.patTxt.textContent = "Off";
      setBar(el.patBar, 0, 1, "idle");
    } else if (s.recPhase === "pattern") {
      el.patLabel.textContent = "Recovery pattern — " + leg + " losing digits " + losingRange(leg);
      el.patTxt.textContent = s.patCount + " / " + s.patNeed;
      setBar(el.patBar, s.patCount, s.patNeed, "");
    } else if (s.recPhase) {
      el.patLabel.textContent = "Recovery pattern — " + leg + " losing digits " + losingRange(leg);
      el.patTxt.textContent = "done";
      setBar(el.patBar, 1, 1, "ready");
    } else {
      el.patLabel.textContent = "Recovery pattern (losing digits)";
      el.patTxt.textContent = "—";
      setBar(el.patBar, 0, 1, "idle");
    }
    if (s.recPhase === "confirm") {
      el.recLabel.textContent = "Recovery confirmation — " + leg + " winning digits " + winningRange(leg);
      el.recTxt.textContent = s.recCount + " / " + s.recNeed;
      setBar(el.recBar, s.recCount, s.recNeed, "");
    } else if (s.recPhase === "open") {
      el.recLabel.textContent = "Recovery confirmation — " + leg;
      el.recTxt.textContent = "trade open";
      setBar(el.recBar, 1, 1, "ready");
    } else if (s.recPhase === "pattern") {
      el.recLabel.textContent = "Recovery confirmation — " + leg + " winning digits " + winningRange(leg);
      el.recTxt.textContent = "waiting for pattern";
      setBar(el.recBar, 0, 1, "idle");
    } else {
      el.recLabel.textContent = "Recovery confirmation";
      el.recTxt.textContent = "—";
      setBar(el.recBar, 0, 1, "idle");
    }

    // boxes
    el.profit.textContent = signed(s.profit);
    el.profit.className = "sniper-big" + (s.profit > 0 ? " sniper-pos" : s.profit < 0 ? " sniper-neg" : "");
    el.profitSub.textContent = s.estimated ? "Includes a loss awaiting Deriv's confirmation" : "Confirmed Deriv results" + (s.open ? " · " + s.open + " open" : "");
    el.profitSub.className = "ph-sub" + (s.estimated ? " est" : "");
    const slHit = s.profit <= -s.sl, tpHit = s.profit >= s.tp;
    el.profitLimits.textContent = (slHit ? "Stop loss reached" : "SL " + money(s.sl + s.profit) + " left") + " · " + (tpHit ? "Take profit reached" : "TP " + money(s.tp - s.profit) + " to go");
    el.tNext.textContent = lastCfg && !lastCfg.recoveryEnabled ? "Off" : money(s.nextRecStake);
    el.cBought.textContent = String(s.bought);
    el.cWins.textContent = String(s.wins);
    el.cLosses.textContent = String(s.losses);
  }

  function resetDash(cfg) {
    el.histBody.innerHTML = ""; rowEls.clear(); el.histEmpty.classList.remove("hidden");
    render({ mode: "waiting", reconnecting: false, entrySkipLeft: cfg.skipRun, entrySkipNeed: cfg.skipRun, patCount: 0, patNeed: cfg.recPattern,
      recCount: 0, recNeed: cfg.recConfirm, recPhase: null, recContract: null, recTrades: 0, maxRec: cfg.maxRec,
      level: 0, stake: cfg.stake, nextRecStake: Math.round(cfg.stake * cfg.mult * 100) / 100,
      bought: 0, wins: 0, losses: 0, open: 0, profit: 0, estimated: false, tp: cfg.tp, sl: cfg.sl });
  }

  // ==========================================================
  // Trade history
  // ==========================================================
  const rowEls = new Map();
  const MAX_ROWS = 500;
  function upsertRow(r) {
    el.histEmpty.classList.add("hidden");
    let tr = rowEls.get(r.id);
    const isNew = !tr;
    if (isNew) { tr = document.createElement("tr"); rowEls.set(r.id, tr); }
    const resCls = r.status === "won" ? "ph-won" : r.status === "lost" ? "ph-lost" : "ph-open";
    const resTxt = r.status === "won" ? "Won" : r.status === "lost" ? "Lost" : "Open";
    const est = r.status !== "open" && !r.confirmed;     // loss read from the exit digit, Deriv's figure still to come
    tr.innerHTML =
      "<td>" + r.id + "</td>" +
      '<td class="txt">' + r.phase + "</td>" +
      '<td class="txt">' + r.label + "</td>" +
      '<td class="r">' + money(r.stake) + "</td>" +
      '<td class="' + resCls + '">' + resTxt + "</td>" +
      '<td class="r ' + resCls + '"' + (est ? ' title="Estimated - awaiting Deriv\'s confirmed figure"' : "") + ">" + (r.profit === null ? "—" : signed(r.profit) + (est ? "*" : "")) + "</td>";
    if (isNew) {
      el.histBody.insertBefore(tr, el.histBody.firstChild);     // newest first
      while (el.histBody.children.length > MAX_ROWS) { el.histBody.removeChild(el.histBody.lastChild); }
    }
  }

  // ==========================================================
  // Run / Stop
  // ==========================================================
  el.run.addEventListener("click", () => {
    if (session) return;
    if (otherRunning) { log("The " + otherRunning + " bot is running. Stop it first."); return; }
    if (!isOpen()) { log("Not connected to Deriv yet."); return; }
    const cfg = readConfig();
    if (!cfg) return;

    const acct = activeAccount();
    if (acct && acct.account_type !== "demo") {
      if (!confirm("This bot will run on your REAL account and place real trades. Continue?")) return;
    }

    clearMsg();
    lastCfg = cfg;
    resetDash(cfg);
    setRunningUI(true);
    announce(true);
    session = startHedge2Engine(deps, cfg, {
      log: log,
      state: render,
      trade: upsertRow,
      finished: () => { session = null; announce(false); setRunningUI(false); },
    });
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

  // ---------- tab lifecycle ----------
  document.addEventListener("algotrade:tab-shown", (e) => {
    if (e.detail.tab !== "pro-hedging-2") return;
    updateBanner();
    if ((AppState.allSymbols || []).length) populateMarketSelect();
    renderDigits();
    paintPreview();
  });

  // ---------- layout safety (see "Layout safety" in pro-hedging.css) ----------
  const accountScreen = $("account-screen");
  function syncLayoutClass() {
    const on = !tabEl.classList.contains("hidden") && !!accountScreen && !accountScreen.classList.contains("hidden");
    document.body.classList.toggle("hedge2-active", on);
  }
  const layoutObserver = new MutationObserver(syncLayoutClass);
  layoutObserver.observe(tabEl, { attributes: true, attributeFilter: ["class"] });
  if (accountScreen) layoutObserver.observe(accountScreen, { attributes: true, attributeFilter: ["class"] });
  syncLayoutClass();

  buildCells();
  renderDigits();
  paintPreview();
})();
