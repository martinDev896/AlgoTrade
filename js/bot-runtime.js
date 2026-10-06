// ==========================================================
// AlgoTrade — bot-runtime.js
// Two things live here:
//   1. BotRuntime — the engine that executes a bot's generated code.
//      Its methods (purchase, purchaseAccumulator, getLastDigit, ...)
//      are exactly what bot-blocks.js's generators call into.
//   2. The Blockly workspace itself — toolbox, injection, and the
//      Run / Stop / Save / Load / Clear controls.
//
// Safety model: this runs the user's OWN strategy, built from their
// OWN blocks, against their OWN account, entirely in their OWN
// browser. There is no "untrusted input" to sandbox against here —
// the safety that matters is: a visible Stop that actually stops
// between trades, and a confirmation step before running on a real
// (not demo) account.
// ==========================================================

class BotStopSignal extends Error {}

const BotRuntime = {
  running: false,
  totalProfit: 0,
  _lastWon: null,
  _lastProfit: 0,
  _lastQuote: null,
  _lastDigit: null,
  _pipSize: 0.001,
};

window.BotRuntime = BotRuntime;

// ---------- Live market state (own small tick listener, same pattern
// as digits.js/chart.js — reads the shared broadcast, no new subscription) ----------
function botDecimalPlacesFor(pipSize) {
  const str = String(pipSize);
  const dot = str.indexOf(".");
  return dot === -1 ? 0 : str.length - dot - 1;
}

document.addEventListener("algotrade:symbol-selected", (e) => {
  const meta = AppState.allSymbols.find((s) => s.symbol === e.detail.symbol);
  BotRuntime._pipSize = meta ? meta.pipSize : 0.001;
});

document.addEventListener("algotrade:tick", (e) => {
  if (e.detail.symbol !== AppState.selectedSymbol) return;
  BotRuntime._lastQuote = Number(e.detail.quote);
  const places = botDecimalPlacesFor(BotRuntime._pipSize);
  BotRuntime._lastDigit = Number(Number(e.detail.quote).toFixed(places).slice(-1));
});

// ---------- Accessors used by the value blocks ----------
BotRuntime.getCurrentPrice = () => BotRuntime._lastQuote ?? 0;
BotRuntime.getLastDigit = () => BotRuntime._lastDigit ?? 0;
BotRuntime.lastTradeWon = () => !!BotRuntime._lastWon;
BotRuntime.lastTradeProfit = () => BotRuntime._lastProfit;
BotRuntime.getTotalProfit = () => BotRuntime.totalProfit;

// Lets strategy logic stop itself (the "Stop Bot" block), distinct from
// the toolbar's Stop button (the user stopping it) — both just flip the
// same flag, which botCheckRunning() checks between every purchase.
BotRuntime.stop = () => {
  BotRuntime.running = false;
  BotRuntime.log("Stop Bot block triggered.");
};

// ---------- Log panel ----------
const botLogEl = document.getElementById("bot-log");

BotRuntime.log = (message) => {
  const empty = botLogEl.querySelector(".bot-log-empty");
  if (empty) empty.remove();

  const line = document.createElement("div");
  line.className = "bot-log-line";
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  botLogEl.appendChild(line);
  botLogEl.scrollTop = botLogEl.scrollHeight;
};

function botActiveCurrency() {
  const acct = AppState.accounts.find((a) => a.account_id === AppState.activeAccountId);
  return acct ? acct.currency : "USD";
}

function botCheckRunning() {
  if (!BotRuntime.running) throw new BotStopSignal();
}

// Watches a bought contract until it settles. Reused for both regular
// purchases and the Accumulator's own early-settlement case (e.g. it
// hits its barrier before the bot's hold period is up).
function botWaitForSettlement(contractId) {
  return new Promise((resolve, reject) => {
    const unsubscribe = derivAPI.subscribe(
      { proposal_open_contract: 1, contract_id: contractId },
      (data) => {
        const poc = data.proposal_open_contract;
        if (!poc) return;
        if (poc.is_sold || (poc.status && poc.status !== "open")) {
          unsubscribe();
          resolve(poc);
        }
      }
    );
  });
}

function botRecordResult(poc, isDigit) {
  BotRuntime._lastWon = poc.status === "won";
  BotRuntime._lastProfit = Number(poc.profit) || 0;
  BotRuntime.totalProfit += BotRuntime._lastProfit;
  BotRuntime.log(
    `${BotRuntime._lastWon ? "WON" : "LOST"} ${BotRuntime._lastProfit.toFixed(2)} ${botActiveCurrency()} — total ${BotRuntime.totalProfit.toFixed(2)}`
  );
  if (isDigit) document.dispatchEvent(new CustomEvent("algotrade:digit-contract-ended"));
  if (window.showTradeResultPopup) window.showTradeResultPopup(poc);
}

// ---------- Purchase: Rise/Fall and Digits ----------
BotRuntime.purchase = async (contractType, params) => {
  botCheckRunning();
  if (!AppState.selectedSymbol) throw new Error("No market selected in Manual Trader.");

  const isDigit = contractType.startsWith("DIGIT");
  const req = {
    proposal: 1,
    amount: params.amount,
    basis: "stake",
    contract_type: contractType,
    currency: botActiveCurrency(),
    underlying_symbol: AppState.selectedSymbol,
    duration: params.duration,
    duration_unit: params.duration_unit,
  };
  if (params.barrier !== undefined) req.barrier = params.barrier;

  const proposalRes = await derivAPI.send(req);
  if (!proposalRes.proposal) throw new Error(proposalRes.error?.message || "No price available for this trade.");
  botCheckRunning();

  const buyRes = await derivAPI.send({ buy: proposalRes.proposal.id, price: proposalRes.proposal.ask_price });
  if (!buyRes.buy) throw new Error(buyRes.error?.message || "Trade did not go through.");
  BotRuntime.log(`Bought ${contractType} — contract #${buyRes.buy.contract_id}`);

  if (isDigit) {
    document.dispatchEvent(
      new CustomEvent("algotrade:digit-contract-active", {
        detail: { contractType, barrier: params.barrier ?? null, duration: params.duration, durationUnit: params.duration_unit },
      })
    );
  }

  const poc = await botWaitForSettlement(buyRes.buy.contract_id);
  botRecordResult(poc, isDigit);
  botCheckRunning();
};

// ---------- Purchase: Accumulator (no fixed expiry — holds N ticks, then sells) ----------
BotRuntime.purchaseAccumulator = async ({ growth_rate, amount, holdTicks }) => {
  botCheckRunning();
  if (!AppState.selectedSymbol) throw new Error("No market selected in Manual Trader.");

  const proposalRes = await derivAPI.send({
    proposal: 1,
    amount,
    basis: "stake",
    contract_type: "ACCU",
    currency: botActiveCurrency(),
    underlying_symbol: AppState.selectedSymbol,
    growth_rate,
  });
  if (!proposalRes.proposal) throw new Error(proposalRes.error?.message || "No price available for this trade.");
  botCheckRunning();

  const buyRes = await derivAPI.send({ buy: proposalRes.proposal.id, price: proposalRes.proposal.ask_price });
  if (!buyRes.buy) throw new Error(buyRes.error?.message || "Trade did not go through.");
  const contractId = buyRes.buy.contract_id;
  BotRuntime.log(`Bought Accumulator — contract #${contractId}, holding ${holdTicks} ticks`);

  const settlementPromise = botWaitForSettlement(contractId);
  let settledEarly = false;
  settlementPromise.then(() => { settledEarly = true; });

  let ticksLeft = holdTicks;
  await new Promise((resolve) => {
    const tickHandler = (e) => {
      if (settledEarly || e.detail.symbol !== AppState.selectedSymbol) return;
      ticksLeft -= 1;
      if (ticksLeft <= 0) {
        document.removeEventListener("algotrade:tick", tickHandler);
        resolve();
      }
    };
    document.addEventListener("algotrade:tick", tickHandler);
    settlementPromise.then(() => {
      document.removeEventListener("algotrade:tick", tickHandler);
      resolve();
    });
  });

  if (!settledEarly) {
    // Hold period reached — sell at market (price: 0 = accept any price).
    try {
      await derivAPI.send({ sell: contractId, price: 0 });
      BotRuntime.log("Hold period reached — selling now.");
    } catch (err) {
      BotRuntime.log("Sell request failed: " + err.message);
    }
  }

  const poc = await settlementPromise;
  botRecordResult(poc, false);
  botCheckRunning();
};

// ==========================================================
// Blockly workspace
// ==========================================================

const BOT_TOOLBOX_XML = `
<xml id="bot-toolbox" style="display: none">
  <category name="Triggers" colour="45">
    <block type="when_run"></block>
  </category>
  <category name="Trading" colour="160">
    <block type="purchase_rise_fall">
      <value name="STAKE"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    </block>
    <block type="purchase_digits">
      <value name="STAKE"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    </block>
    <block type="purchase_accumulator">
      <value name="STAKE"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    </block>
    <block type="stop_bot"></block>
  </category>
  <category name="Market Data" colour="45">
    <block type="current_price_value"></block>
    <block type="last_digit_value"></block>
    <block type="last_trade_won_value"></block>
    <block type="last_trade_profit_value"></block>
    <block type="total_profit_value"></block>
  </category>
  <category name="Logic" colour="%{BKY_LOGIC_HUE}">
    <block type="controls_if"></block>
    <block type="logic_compare"></block>
    <block type="logic_operation"></block>
    <block type="logic_negate"></block>
    <block type="logic_boolean"></block>
  </category>
  <category name="Loops" colour="%{BKY_LOOPS_HUE}">
    <block type="controls_repeat_ext">
      <value name="TIMES"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
    </block>
    <block type="controls_whileUntil"></block>
  </category>
  <category name="Math" colour="%{BKY_MATH_HUE}">
    <block type="math_number"></block>
    <block type="math_arithmetic"></block>
    <block type="math_round"></block>
    <block type="math_modulo"></block>
  </category>
  <category name="Text" colour="%{BKY_TEXTS_HUE}">
    <block type="text"></block>
  </category>
  <category name="Variables" colour="%{BKY_VARIABLES_HUE}" custom="VARIABLE"></category>
</xml>`;

const BOT_STORAGE_KEY = "algotrade_bot_xml";
const DEFAULT_BOT_XML =
  '<xml xmlns="https://developers.google.com/blockly/xml"><block type="when_run" x="30" y="30"></block></xml>';

// Blockly.utils.xml.textToDom (v9+) vs Blockly.Xml.textToDom (older) —
// try both rather than assume, so a version mismatch fails loudly in
// the console instead of silently leaving the workspace empty.
function botTextToDom(text) {
  if (Blockly.utils?.xml?.textToDom) return Blockly.utils.xml.textToDom(text);
  if (Blockly.Xml?.textToDom) return Blockly.Xml.textToDom(text);
  throw new Error("Blockly's textToDom utility was not found at either known location.");
}

let botWorkspace = null;

function initBotWorkspace() {
  if (botWorkspace) return;

  const container = document.getElementById("bot-workspace-container");

  if (typeof Blockly === "undefined" || !Blockly.inject) {
    container.innerHTML =
      '<p class="chart-error">Bot Builder failed to load (Blockly library didn\'t load). Check your internet connection and reload the page.</p>';
    return;
  }

  botWorkspace = Blockly.inject(container, {
    toolbox: BOT_TOOLBOX_XML,
    trashcan: true,
    zoom: { controls: true, wheel: true, startScale: 0.9 },
    grid: { spacing: 24, length: 2, colour: "#E4E7EB", snap: true },
  });

  const savedXml = localStorage.getItem(BOT_STORAGE_KEY) || DEFAULT_BOT_XML;
  try {
    Blockly.Xml.domToWorkspace(botTextToDom(savedXml), botWorkspace);
  } catch (err) {
    console.error("Could not load saved bot, starting fresh:", err.message);
  }

  let saveTimer = null;
  botWorkspace.addChangeListener((e) => {
    if (e.isUiEvent) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const xmlText = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(botWorkspace));
      localStorage.setItem(BOT_STORAGE_KEY, xmlText);
    }, 600);
  });
}

document.addEventListener("algotrade:tab-shown", (e) => {
  if (e.detail.tab !== "bot-builder") return;
  initBotWorkspace();
  setTimeout(() => Blockly.svgResize(botWorkspace), 50);
});

// ---------- Run / Stop / Save / Load / Clear ----------
const botRunBtn = document.getElementById("bot-run-btn");
const botStopBtn = document.getElementById("bot-stop-btn");
const botSaveBtn = document.getElementById("bot-save-btn");
const botLoadBtn = document.getElementById("bot-load-btn");
const botClearBtn = document.getElementById("bot-clear-btn");
const botStatusEl = document.getElementById("bot-status");

function setBotStatus(text, running) {
  botStatusEl.textContent = text;
  botRunBtn.disabled = running;
  botStopBtn.disabled = !running;
}

botRunBtn.addEventListener("click", () => {
  if (!botWorkspace) return;

  const acct = AppState.accounts.find((a) => a.account_id === AppState.activeAccountId);
  if (acct && acct.account_type !== "demo") {
    const ok = confirm("This bot will run on your REAL account and place real trades. Continue?");
    if (!ok) return;
  }

  const code = Blockly.JavaScript.workspaceToCode(botWorkspace);
  if (!code.trim()) {
    BotRuntime.log("Nothing to run — add blocks under 'When Run' first.");
    return;
  }

  BotRuntime.running = true;
  BotRuntime.totalProfit = 0;
  setBotStatus("Running…", true);
  BotRuntime.log("Bot started.");

  const runner = new Function(
    "BotRuntime",
    `return (async () => { ${code} })();`
  );

  runner(BotRuntime)
    .catch((err) => {
      if (err instanceof BotStopSignal) {
        BotRuntime.log("Bot stopped.");
      } else {
        BotRuntime.log("Error: " + err.message);
        console.error(err);
      }
    })
    .finally(() => {
      BotRuntime.running = false;
      setBotStatus("Not running", false);
    });
});

botStopBtn.addEventListener("click", () => {
  BotRuntime.running = false;
  setBotStatus("Stopping…", true);
});

botSaveBtn.addEventListener("click", () => {
  if (!botWorkspace) return;
  const xmlText = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(botWorkspace));
  localStorage.setItem(BOT_STORAGE_KEY, xmlText);
  BotRuntime.log("Bot saved.");
});

botLoadBtn.addEventListener("click", () => {
  if (!botWorkspace) return;
  const xmlText = localStorage.getItem(BOT_STORAGE_KEY);
  if (!xmlText) {
    BotRuntime.log("No saved bot found.");
    return;
  }
  botWorkspace.clear();
  Blockly.Xml.domToWorkspace(botTextToDom(xmlText), botWorkspace);
  BotRuntime.log("Bot loaded.");
});

botClearBtn.addEventListener("click", () => {
  if (!botWorkspace) return;
  if (!confirm("Clear the whole workspace? This can't be undone.")) return;
  botWorkspace.clear();
  Blockly.Xml.domToWorkspace(botTextToDom(DEFAULT_BOT_XML), botWorkspace);
});
