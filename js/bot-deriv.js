// ==========================================================
// AlgoTrade — bot-deriv.js
// The Bot Builder tab, built on Deriv's own Bot Builder blocks (deriv-bot/deriv-bot.js — Deriv Bot,
// MIT License, Copyright (c) 2024 deriv.com; see deriv-bot/LICENSE).
//
// PHASE 1 (this file): build bots with Deriv's blocks, import/export Deriv XML files, keep your last bot.
// PHASE 2 (not built yet): the Run button — it only explains that for now.
// ==========================================================
(function () {
  const STORAGE_KEY = "algotrade_deriv_bot_xml";
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

  const tabBtn = document.querySelector('[data-tab="bot-builder"]');
  const container = document.getElementById("bot-workspace-container");
  const logEl = document.getElementById("bot-log");
  const statusEl = document.getElementById("bot-status");
  const importBtn = document.getElementById("bot-import-btn");
  const importInput = document.getElementById("bot-import-input");
  const exportBtn = document.getElementById("bot-export-btn");
  const clearBtn = document.getElementById("bot-clear-btn");
  const runBtn = document.getElementById("bot-run-btn");
  if (!tabBtn || !container) return;

  let state = "idle";            // idle -> loading -> ready
  let dirty = false;             // true once the user has changed the blocks since the last load/import
  let ignoreChangesUntil = 0;    // Deriv's dropdowns keep settling for a moment after a load
  let saveTimer = null;

  // ---------- small UI helpers ----------
  function log(message, kind) {
    const empty = logEl.querySelector(".bot-log-empty");
    if (empty) empty.remove();
    const line = document.createElement("p");
    line.className = "bot-log-line" + (kind ? " " + kind : "");
    line.textContent = new Date().toLocaleTimeString() + "  " + message;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
  const setStatus = (text) => { statusEl.textContent = text; };
  const bot = () => window.DerivBot;

  function activeCurrency() {
    const st = window.AppState;
    const acct = st && st.accounts && st.accounts.find((a) => a.account_id === st.activeAccountId);
    return acct ? acct.currency : "USD";
  }

  // The block dropdowns are filled from Deriv's market data, so the connection must be up first.
  function whenConnected() {
    return new Promise((resolve) => {
      if (window.AppState && window.AppState.activeAccountId) return resolve();
      setStatus("Waiting for your Deriv connection…");
      document.addEventListener("algotrade:account-ready", () => resolve(), { once: true });
    });
  }

  // ---------- saving the last bot ----------
  function saveNow() {
    try { localStorage.setItem(STORAGE_KEY, bot().exportXml()); } catch (e) { /* storage full/blocked: not critical */ }
  }
  function onWorkspaceChange(event) {
    if (event.isUiEvent) return;
    if (Date.now() > ignoreChangesUntil) dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 800);
  }
  function markFreshlyLoaded() {
    dirty = false;
    ignoreChangesUntil = Date.now() + 2000;
  }

  // The Deriv blocks are a 1.3 MB download, so they are fetched the first time this tab is opened
  // rather than on every page load (people who only trade manually never pay for them).
  let assetsPromise = null;
  function loadAssets() {
    if (window.DerivBot) return Promise.resolve();
    if (!assetsPromise) {
      assetsPromise = new Promise((resolve, reject) => {
        const css = document.createElement("link");
        css.rel = "stylesheet"; css.href = "deriv-bot/deriv-bot.css";
        document.head.appendChild(css);
        const js = document.createElement("script");
        js.src = "deriv-bot/deriv-bot.js";
        js.onload = () => (window.DerivBot ? resolve() : reject(new Error("deriv-bot.js ran but did not define DerivBot")));
        js.onerror = () => reject(new Error("could not download deriv-bot/deriv-bot.js"));
        document.body.appendChild(js);
      }).catch((err) => { assetsPromise = null; throw err; }); // allow a retry on the next tab click
    }
    return assetsPromise;
  }

  // ---------- start-up (first time the tab is opened) ----------
  async function start() {
    if (state !== "idle") return;
    state = "loading";
    setStatus("Downloading Deriv blocks…");
    try {
      await Promise.all([loadAssets(), whenConnected()]);
      setStatus("Loading Deriv blocks…");
      await bot().init(container, { mediaPath: "deriv-bot/media/", currency: activeCurrency() });

      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        bot().getWorkspace().clear();
        const res = await bot().importXml(saved, "last-bot");
        if (res.ok) log("Restored your last bot.");
        else { log("Could not restore your last bot (" + res.error + "). Loaded the starter blocks instead.", "error"); await bot().reset(); }
      }
      markFreshlyLoaded();
      bot().getWorkspace().addChangeListener(onWorkspaceChange);
      new ResizeObserver(() => bot().resize()).observe(container);
      state = "ready";
      setStatus("Ready · running bots arrives in the next phase");
    } catch (err) {
      console.error("Bot Builder failed to start:", err);
      container.innerHTML = "";
      state = "idle";
      setStatus("Bot Builder failed to start");
      log("Could not start the Bot Builder: " + (err && err.message ? err.message : err), "error");
    }
  }

  // ---------- import / export / clear ----------
  async function replaceWorkspace(text, name) {
    const ws = bot().getWorkspace();
    const backup = bot().exportXml(); // so a bad file can never cost you your current bot
    ws.clear();
    const res = await bot().importXml(text, name);
    if (res.ok) {
      markFreshlyLoaded();
      saveNow();
      log('Imported "' + name + '".', "success");
    } else {
      ws.clear();
      await bot().importXml(backup, "previous-bot");
      log('Import failed: ' + res.error + " Your previous bot was restored.", "error");
    }
  }

  importBtn.addEventListener("click", () => {
    if (state !== "ready") { log("The Bot Builder is still loading — try again in a moment."); return; }
    importInput.value = ""; // so choosing the same file twice still fires "change"
    importInput.click();
  });

  importInput.addEventListener("change", async () => {
    const file = importInput.files[0];
    if (!file || state !== "ready") return;
    if (file.size > MAX_IMPORT_BYTES) { log('Import failed: "' + file.name + '" is too large to be a bot file.', "error"); return; }

    let text;
    try { text = await file.text(); } catch (e) { log('Import failed: could not read "' + file.name + '".', "error"); return; }
    if (!/<xml[\s>]/i.test(text)) { log('Import failed: "' + file.name + '" is not a bot XML file.', "error"); return; }

    if (dirty && !confirm('Replace the current bot with "' + file.name + '"? Your current blocks will be lost.')) return;
    await replaceWorkspace(text, file.name);
  });

  exportBtn.addEventListener("click", () => {
    if (state !== "ready") { log("The Bot Builder is still loading — try again in a moment."); return; }
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    const filename = "algotrade-bot-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "-" + pad(d.getHours()) + pad(d.getMinutes()) + ".xml";
    const url = URL.createObjectURL(new Blob([bot().exportXml()], { type: "text/xml;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log("Exported " + filename);
  });

  clearBtn.addEventListener("click", async () => {
    if (state !== "ready") return;
    if (dirty && !confirm("Clear the workspace back to the starter blocks? Your current blocks will be lost.")) return;
    await bot().reset();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    markFreshlyLoaded();
    log("Workspace reset to the starter blocks.");
  });

  runBtn.addEventListener("click", () => {
    log("Running bots is the next phase of this build. You can already build, import and export bots with Deriv's blocks.", "info");
  });

  // Opening the tab starts it (and re-measures it if it was already running). The direct click hook is the
  // primary trigger; the shared tab event is a backup.
  const onTabOpened = () => requestAnimationFrame(() => { start(); if (bot() && bot().ready) bot().resize(); });
  tabBtn.addEventListener("click", onTabOpened);
  document.addEventListener("algotrade:tab-shown", (e) => { if (e.detail && e.detail.tab === "bot-builder") onTabOpened(); });
})();
