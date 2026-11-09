// ==========================================================
// AlgoTrade — pro-hedging.js
// UI for the "Pro Hedging" tab. The strategy itself lives in
// pro-hedging-engine.js (no DOM there); this file reads the settings,
// starts/stops the engine and paints the dashboard and trade history.
//
// Shares with the Sniper Trader tab:
//   - the app's ONE connection (derivAPI) and the ONE tick feed ("algotrade:tick")
//   - the ONE market selection (AppState.selectedSymbol / selectSymbol)
//   - the one-bot-at-a-time rule ("algotrade:sniper-run-state"): this bot
//     announces itself as "prohedging", which the Over/Under bot already reacts to
// ==========================================================

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tabEl = $("tab-pro-hedging");
  if (!tabEl) return;

  const el = {
    marketLine: $("ph-market-line"), banner: $("ph-banner"), marketSelect: $("ph-market-select"),
    stake: $("ph-stake"), duration: $("ph-duration"), nDigits: $("ph-ndigits"), tp: $("ph-tp"), sl: $("ph-sl"),
    confirm: $("ph-confirm"), mult: $("ph-mult"), maxRec: $("ph-maxrec"), recDur: $("ph-recdur"),
    maxStake: $("ph-maxstake"), afterLimit: $("ph-afterlimit"),
    recovery: $("ph-recovery"), immediate: $("ph-immediate"), fast: $("ph-fast"), hardStop: $("ph-hardstop"),
    preview: $("ph-preview"), run: $("ph-run"), stop: $("ph-stop"), msg: $("ph-msg"),
    mode: $("ph-mode"), digitNow: $("ph-digit-now"), digits: $("ph-digits"),
    entryTxt: $("ph-entry-txt"), entryBar: $("ph-entry-bar"), recLabel: $("ph-rec-label"), recTxt: $("ph-rec-txt"), recBar: $("ph-rec-bar"),
    profit: $("ph-profit"), profitSub: $("ph-profit-sub"),
    tMarket: $("ph-t-market"), tStake: $("ph-t-stake"), tNext: $("ph-t-next"), tLevel: $("ph-t-level"),
    tRecContract: $("ph-t-reccontract"), tRecAttempts: $("ph-t-recattempts"),
    tBought: $("ph-t-bought"), tWins: $("ph-t-wins"), tLosses: $("ph-t-losses"),
    tSl: $("ph-t-sl"), tSlSub: $("ph-t-sl-sub"), tTp: $("ph-t-tp"), tTpSub: $("ph-t-tp-sub"), tTime: $("ph-t-time"),
    histBody: $("ph-hist-body"), histEmpty: $("ph-hist-empty"),
  };

  const SETTINGS = [el.marketSelect, el.stake, el.duration, el.nDigits, el.tp, el.sl, el.confirm, el.mult, el.maxRec, el.recDur,
    el.maxStake, el.afterLimit, el.recovery, el.immediate, el.fast, el.hardStop];

  let session = null;
  let lastCfg = null;
  let startedAt = null, timer = null;
  let otherRunning = null;            // name of another bot that is running, if any
  let recent = [];                    // last digits for the strip

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
  const QUIET = /^(timing:|Started:|Stop requested|Recovery for the losing|Recovery won|Both contracts won|Bot stopped|Reconnected|Connection lost)/;
  function log(text) {
    console.debug("[Pro Hedging] " + text);
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
  // Market dropdown (shared selection — same approach as the Sniper tab)
  // ==========================================================
  function populateMarketSelect() {
    const synth = (AppState.allSymbols || []).filter(isSynthetic);
    el.marketSelect.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = "Choose a synthetic index…";
    el.marketSelect.appendChild(ph);
    synth.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.symbol; o.textContent = s.displayName;
      el.marketSelect.appendChild(o);
    });
    syncSelection();
  }
  function syncSelection() {
    const meta = symbolMeta(AppState.selectedSymbol);
    const ok = isSynthetic(meta);
    el.marketSelect.value = ok ? meta.symbol : "";
    el.marketLine.textContent = ok ? meta.displayName : "No synthetic index selected";
    el.tMarket.textContent = ok ? meta.displayName : "—";
  }
  el.marketSelect.addEventListener("change", () => {
    const symbol = el.marketSelect.value;
    if (!symbol || session) return;
    const meta = symbolMeta(symbol);
    if (typeof selectSymbol === "function") selectSymbol(symbol, meta ? meta.displayName : symbol);
  });
  document.addEventListener("algotrade:symbol-selected", () => {
    if (!(AppState.allSymbols || []).length) return;
    recent = []; paintDigits();
    if (el.marketSelect.options.length <= 1) populateMarketSelect(); else syncSelection();
  });

  // ==========================================================
  // Latest digits (display only — the engine reads the same tick feed itself)
  // ==========================================================
  document.addEventListener("algotrade:tick", (e) => {
    const d = e.detail || {};
    if (d.symbol !== AppState.selectedSymbol) return;
    const meta = symbolMeta(d.symbol);
    const dec = meta ? decimalPlacesFor(meta.pipSize) : 2;
    const digit = Number(Number(d.quote).toFixed(dec).slice(-1));
    recent.push(digit);
    if (recent.length > 20) recent.shift();
    if (tabIsVisible()) paintDigits();
  });
  function paintDigits() {
    const last = recent.length ? recent[recent.length - 1] : null;
    el.digitNow.textContent = last === null ? "–" : String(last);
    el.digitNow.classList.toggle("skip", last === 4 || last === 5);
    el.digits.innerHTML = recent.map((d) => '<span class="ph-dg' + (d === 4 || d === 5 ? " skip" : "") + '">' + d + "</span>").join("");
  }

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
      stake: num(el.stake), duration: num(el.duration), nEntry: num(el.nDigits), tp: num(el.tp), sl: num(el.sl),
      recoveryEnabled: !!el.recovery.checked, immediate: !!el.immediate.checked, fastRecovery: !!el.fast.checked, hardStop: !!el.hardStop.checked,
      recConfirm: num(el.confirm), mult: num(el.mult), maxRec: num(el.maxRec), recDuration: num(el.recDur),
      maxStake: num(el.maxStake), afterLimit: el.afterLimit.value,
    };
    let err = null;
    if (!(cfg.stake >= 0.35)) err = "Initial stake must be at least 0.35.";
    else if (!int(el.duration) || cfg.duration < 1 || cfg.duration > 10) err = "Ticks must be a whole number from 1 to 10.";
    else if (!int(el.nDigits) || cfg.nEntry < 1 || cfg.nEntry > 20) err = "Digits in a row must be a whole number from 1 to 20.";
    else if (!(cfg.tp > 0) || !(cfg.sl > 0)) err = "Take profit and stop loss must be above 0.";
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
    if (e.detail.bot === "prohedging") return;
    running[e.detail.bot] = !!e.detail.running;
    otherRunning = running.overunder ? "Over/Under" : running.evenodd ? "Even/Odd" : null;
    setRunningUI(!!session);
  });
  const announce = (on) => document.dispatchEvent(new CustomEvent("algotrade:sniper-run-state", { detail: { bot: "prohedging", running: on } }));

  function setRunningUI(on) {
    el.run.disabled = on || !!otherRunning;
    el.run.title = otherRunning && !on ? "The " + otherRunning + " bot is running. Stop it first." : "";
    el.stop.disabled = !on;
    SETTINGS.forEach((x) => { x.disabled = on || (x === el.marketSelect && !!otherRunning); });
    el.marketSelect.title = on ? "Stop the running bot to change market" : "";
  }

  // ==========================================================
  // Dashboard
  // ==========================================================
  const MODE_TEXT = { waiting: "Waiting", entry: "Entry", recovery: "Recovery", stopped: "Stopped" };
  function setBar(barEl, count, need, state) {
    barEl.className = "ph-bar" + (state ? " " + state : "");
    barEl.firstElementChild.style.width = need > 0 ? Math.round((count / need) * 100) + "%" : "0%";
  }

  function render(s) {
    // mode chip
    const stopped = s.mode === "stopped";
    el.mode.textContent = s.reconnecting ? "Reconnecting…" : MODE_TEXT[s.mode] || "Stopped";
    el.mode.className = "sniper-chip" + (s.reconnecting ? " warn" : !stopped ? " running" : "");

    // confirmation progress
    const waiting = s.mode === "waiting";
    el.entryTxt.textContent = waiting ? s.entryCount + " / " + s.entryNeed : "—";
    setBar(el.entryBar, waiting ? s.entryCount : 0, s.entryNeed, waiting ? "" : "idle");
    if (s.recContract && s.recPhase === "confirm") {
      el.recLabel.textContent = "Recovery confirmation (" + s.recContract + ")";
      el.recTxt.textContent = s.recCount + " / " + s.recNeed;
      setBar(el.recBar, s.recCount, s.recNeed, "");
    } else if (s.recContract) {
      el.recLabel.textContent = "Recovery confirmation (" + s.recContract + ")";
      el.recTxt.textContent = "trade open";
      setBar(el.recBar, 1, 1, "ready");
    } else {
      el.recLabel.textContent = "Recovery confirmation";
      el.recTxt.textContent = "—";
      setBar(el.recBar, 0, 1, "idle");
    }

    // tiles
    el.tStake.textContent = money(s.stake);
    el.tNext.textContent = lastCfg && !lastCfg.recoveryEnabled ? "Off" : money(s.nextRecStake);
    el.tLevel.textContent = String(s.level);
    el.tRecContract.textContent = s.recContract || "—";
    el.tRecAttempts.textContent = s.recContract ? s.recTrades + " / " + s.maxRec : "0 / " + s.maxRec;
    el.tBought.textContent = String(s.bought);
    el.tWins.textContent = String(s.wins);
    el.tLosses.textContent = String(s.losses);
    el.profit.textContent = signed(s.profit);
    el.profit.className = "sniper-big" + (s.profit > 0 ? " sniper-pos" : s.profit < 0 ? " sniper-neg" : "");
    el.profitSub.textContent = s.estimated ? "Includes a loss awaiting Deriv's confirmation" : "Confirmed Deriv results" + (s.open ? " · " + s.open + " open" : "");
    el.profitSub.className = "ph-sub" + (s.estimated ? " est" : "");

    // stop loss / take profit status (combined net result, recovery included)
    const slHit = s.profit <= -s.sl, tpHit = s.profit >= s.tp;
    el.tSl.textContent = slHit ? "Reached" : "OK";
    el.tSl.className = "sniper-big sm " + (slHit ? "ph-reached" : "ph-ok");
    el.tSlSub.textContent = slHit ? "−" + money(s.sl) + " hit" : money(s.sl + s.profit) + " left of " + money(s.sl);
    el.tTp.textContent = tpHit ? "Reached" : "OK";
    el.tTp.className = "sniper-big sm " + (tpHit ? "ph-ok" : "");
    el.tTpSub.textContent = tpHit ? "+" + money(s.tp) + " hit" : money(s.tp - s.profit) + " to go of " + money(s.tp);
  }

  function resetDash(cfg) {
    el.tMarket.textContent = (symbolMeta(cfg.symbol) || {}).displayName || cfg.symbol;
    el.histBody.innerHTML = ""; rowEls.clear(); el.histEmpty.classList.remove("hidden");
    render({ mode: "waiting", reconnecting: false, entryCount: 0, entryNeed: cfg.nEntry, recCount: 0, recNeed: cfg.recConfirm, recPhase: null, recContract: null,
      recTrades: 0, maxRec: cfg.maxRec, level: 0, stake: cfg.stake, nextRecStake: Math.round(cfg.stake * cfg.mult * 100) / 100,
      bought: 0, wins: 0, losses: 0, open: 0, profit: 0, estimated: false, tp: cfg.tp, sl: cfg.sl });
  }

  // ---------- session clock ----------
  const pad = (n) => String(n).padStart(2, "0");
  function tickClock() {
    if (startedAt === null) return;
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    el.tTime.textContent = pad(Math.floor(sec / 3600)) + ":" + pad(Math.floor((sec % 3600) / 60)) + ":" + pad(sec % 60);
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
    const t = new Date(r.time);
    const resCls = r.status === "won" ? "ph-won" : r.status === "lost" ? "ph-lost" : "ph-open";
    const resTxt = r.status === "won" ? "Won" : r.status === "lost" ? "Lost" : "Open";
    const tag = r.status === "open" ? '<span class="ph-tag">Open</span>' : r.confirmed ? '<span class="ph-tag conf">Confirmed</span>' : '<span class="ph-tag est">Estimated</span>';
    tr.innerHTML =
      "<td>" + r.id + "</td>" +
      "<td>" + pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":" + pad(t.getSeconds()) + "</td>" +
      '<td class="txt">' + r.phase + "</td>" +
      '<td class="txt">' + r.label + "</td>" +
      '<td class="r">' + money(r.stake) + "</td>" +
      '<td class="r">' + (r.phase === "Recovery" ? r.level : "—") + "</td>" +
      '<td class="' + resCls + '">' + resTxt + "</td>" +
      '<td class="r ' + resCls + '">' + (r.profit === null ? "—" : signed(r.profit)) + "</td>" +
      "<td>" + tag + "</td>";
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
    startedAt = Date.now(); tickClock();
    clearInterval(timer); timer = setInterval(tickClock, 1000);
    setRunningUI(true);
    announce(true);
    session = startHedgeEngine(deps, cfg, {
      log: log,
      state: render,
      trade: upsertRow,
      finished: () => { session = null; clearInterval(timer); tickClock(); announce(false); setRunningUI(false); },
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
    if (e.detail.tab !== "pro-hedging") return;
    updateBanner();
    if ((AppState.allSymbols || []).length) populateMarketSelect();
    paintDigits();
    paintPreview();
  });

  // ---------- layout safety (see "Layout safety" in pro-hedging.css) ----------
  const accountScreen = $("account-screen");
  function syncLayoutClass() {
    const on = !tabEl.classList.contains("hidden") && !!accountScreen && !accountScreen.classList.contains("hidden");
    document.body.classList.toggle("hedge-active", on);
  }
  const layoutObserver = new MutationObserver(syncLayoutClass);
  layoutObserver.observe(tabEl, { attributes: true, attributeFilter: ["class"] });
  if (accountScreen) layoutObserver.observe(accountScreen, { attributes: true, attributeFilter: ["class"] });
  syncLayoutClass();

  paintPreview();
  paintDigits();
})();
