// ==========================================================
// AlgoTrade — Dynamic trading panel
// Contract families: Accumulators, Rise/Fall, Higher/Lower,
// Touch/No Touch, Multipliers and Digits.
//
// The UI exposes simple trading actions while the underlying
// Deriv contract_type values remain explicit in the API request.
// ==========================================================

const tradePanelEl = document.getElementById("trade-panel");
const tradeTypeEl = document.getElementById("trade-type-select");
const contractControlsEl = document.getElementById("contract-controls");
const durationEl = document.getElementById("trade-duration");
const durationUnitEl = document.getElementById("trade-duration-unit");
const stakeEl = document.getElementById("trade-stake");
const tradeActionsEl = document.getElementById("trade-actions");
const quoteResultEl = document.getElementById("trade-quote-result");
const payoutEl = document.getElementById("trade-payout");
const costEl = document.getElementById("trade-cost");
const tradeResultEl = document.getElementById("trade-result");
const titleEl = document.getElementById("trade-panel-title");
const miniMarketEl = document.getElementById("trade-market-mini");

let currentProposal = null;
let proposalTimer = null;
let selectedDigit = 0;
let selectedDigitContract = "DIGITMATCH";
let selectedAction = null;
let currentFamily = "accumulators";

const FAMILY_LABELS = {
  accumulators: "Accumulators",
  rise_fall: "Rise / Fall",
  higher_lower: "Higher / Lower",
  touch_no_touch: "Touch / No Touch",
  multipliers: "Multipliers",
  digits: "Digits",
};

function getActiveCurrency() {
  const acct = AppState.accounts.find((a) => a.account_id === AppState.activeAccountId);
  return acct ? acct.currency : "USD";
}

function resetQuote() {
  currentProposal = null;
  quoteResultEl.classList.add("hidden");
  tradeResultEl.classList.add("hidden");
  if (proposalTimer) clearTimeout(proposalTimer);
}

function setAction(action) {
  selectedAction = action;
  tradeActionsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.action === action));
  resetQuote();
  scheduleQuote();
}

function makeButton(label, action, className = "") {
  return `<button type="button" class="trade-action-btn ${className}" data-action="${action}">${label}</button>`;
}

function renderControls() {
  currentFamily = tradeTypeEl.value;
  titleEl.textContent = FAMILY_LABELS[currentFamily];
  resetQuote();

  if (currentFamily === "accumulators") {
    contractControlsEl.innerHTML = `
      <div class="trade-row">
        <label for="growth-rate">Growth rate</label>
        <div class="input-with-suffix"><input id="growth-rate" type="number" min="0.1" step="0.1" value="0.1" class="trade-input" /><span>%</span></div>
      </div>
      <div class="trade-info">The contract accumulates while the market remains inside its barrier range.</div>
    `;
    durationEl.value = 5;
    durationUnitEl.value = "t";
    tradeActionsEl.innerHTML = makeButton("BUY ACCUMULATOR", "ACCU", "trade-action-primary");
    selectedAction = "ACCU";
  } else if (currentFamily === "rise_fall") {
    contractControlsEl.innerHTML = `<div class="trade-subsection-label">Choose direction</div><div class="trade-choice-grid two">${makeButton("▲ RISE", "CALL", "action-rise")}${makeButton("▼ FALL", "PUT", "action-fall")}</div>`;
    tradeActionsEl.innerHTML = "";
    selectedAction = "CALL";
  } else if (currentFamily === "higher_lower") {
    contractControlsEl.innerHTML = `
      <div class="trade-row"><label for="higher-lower-barrier">Barrier</label><input id="higher-lower-barrier" type="text" inputmode="decimal" placeholder="Enter barrier" class="trade-input" /></div>
    `;
    tradeActionsEl.innerHTML = `<div class="trade-choice-grid two">${makeButton("HIGHER", "HIGHER", "action-rise")}${makeButton("LOWER", "LOWER", "action-fall")}</div>`;
    selectedAction = "HIGHER";
  } else if (currentFamily === "touch_no_touch") {
    contractControlsEl.innerHTML = `
      <div class="trade-row"><label for="touch-barrier">Barrier</label><input id="touch-barrier" type="text" inputmode="decimal" placeholder="Enter barrier" class="trade-input" /></div>
    `;
    tradeActionsEl.innerHTML = `<div class="trade-choice-grid two">${makeButton("TOUCH", "ONETOUCH", "action-rise")}${makeButton("NO TOUCH", "NOTOUCH", "action-fall")}</div>`;
    selectedAction = "ONETOUCH";
  } else if (currentFamily === "multipliers") {
    contractControlsEl.innerHTML = `
      <div class="trade-row"><label for="multiplier">Multiplier</label><select id="multiplier" class="trade-select"><option value="10">10×</option><option value="20">20×</option><option value="50">50×</option><option value="100">100×</option></select></div>
    `;
    durationEl.value = 1;
    durationUnitEl.value = "s";
    tradeActionsEl.innerHTML = `<div class="trade-choice-grid two">${makeButton("BUY UP", "MULTUP", "action-rise")}${makeButton("BUY DOWN", "MULTDOWN", "action-fall")}</div>`;
    selectedAction = "MULTUP";
  } else if (currentFamily === "digits") {
    contractControlsEl.innerHTML = `
      <div class="trade-subsection-label">Contract</div>
      <div class="trade-choice-grid three digit-contracts">
        ${makeButton("MATCHES", "DIGITMATCH")}${makeButton("DIFFERS", "DIGITDIFF")}${makeButton("OVER", "DIGITOVER")}
        ${makeButton("UNDER", "DIGITUNDER")}${makeButton("EVEN", "DIGITEVEN")}${makeButton("ODD", "DIGITODD")}
      </div>
      <div class="trade-subsection-label digit-prediction-label">Last prediction digit</div>
      <div id="digit-keypad" class="digit-keypad">${Array.from({length: 10}, (_, d) => `<button type="button" class="digit-key${d === selectedDigit ? " selected" : ""}" data-digit="${d}">${d}</button>`).join("")}</div>
      <div class="selected-digit-summary">Prediction: <strong id="selected-digit-value">${selectedDigit}</strong></div>
    `;
    tradeActionsEl.innerHTML = "";
    selectedAction = selectedDigitContract;

    contractControlsEl.querySelectorAll(".digit-contracts .trade-action-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        selectedDigitContract = btn.dataset.action;
        selectedAction = selectedDigitContract;
        contractControlsEl.querySelectorAll(".digit-contracts .trade-action-btn").forEach((b) => b.classList.toggle("active", b === btn));
        await executeBuy(btn);
      });
    });

    contractControlsEl.querySelectorAll(".digit-key").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedDigit = Number(btn.dataset.digit);
        contractControlsEl.querySelectorAll(".digit-key").forEach((b) => b.classList.toggle("selected", b === btn));
        document.getElementById("selected-digit-value").textContent = selectedDigit;
        resetQuote();
        scheduleQuote();
      });
    });
    const firstContract = contractControlsEl.querySelector(`[data-action="${selectedDigitContract}"]`);
    if (firstContract) firstContract.classList.add("active");
  }

  contractControlsEl.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("input", () => { resetQuote(); scheduleQuote(); });
    el.addEventListener("change", () => { resetQuote(); scheduleQuote(); });
  });

  if (currentFamily === "rise_fall") {
    tradeActionsEl.innerHTML = `<div class="trade-choice-grid two">${makeButton("▲ RISE", "CALL", "action-rise")}${makeButton("▼ FALL", "PUT", "action-fall")}</div>`;
  }

  durationEl.disabled = currentFamily === "multipliers";
  durationUnitEl.disabled = currentFamily === "multipliers";
  scheduleQuote();
}

function buildProposalRequest() {
  const symbol = AppState.selectedSymbol;
  if (!symbol || !selectedAction) return null;

  const amount = Number(stakeEl.value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid stake.");

  const request = {
    proposal: 1,
    amount,
    basis: "stake",
    contract_type: selectedAction,
    currency: getActiveCurrency(),
    underlying_symbol: symbol,
  };

  if (currentFamily !== "multipliers") {
    const duration = Number(durationEl.value);
    if (!Number.isFinite(duration) || duration < 1) throw new Error("Enter a valid duration.");
    request.duration = duration;
    request.duration_unit = durationUnitEl.value;
  }

  if (currentFamily === "accumulators") {
    request.growth_rate = Number(document.getElementById("growth-rate")?.value || 0.1);
  }

  if (currentFamily === "higher_lower") {
    const barrier = document.getElementById("higher-lower-barrier")?.value.trim();
    if (!barrier) throw new Error("Enter a barrier for Higher / Lower.");
    request.barrier = barrier;
  }

  if (currentFamily === "touch_no_touch") {
    const barrier = document.getElementById("touch-barrier")?.value.trim();
    if (!barrier) throw new Error("Enter a barrier for Touch / No Touch.");
    request.barrier = barrier;
  }

  if (currentFamily === "multipliers") {
    request.multiplier = Number(document.getElementById("multiplier")?.value || 10);
  }

  if (currentFamily === "digits") request.barrier = String(selectedDigit);

  return request;
}

async function requestQuote() {
  if (!AppState.selectedSymbol) return;
  try {
    const request = buildProposalRequest();
    if (!request) return;
    const res = await derivAPI.send(request);
    if (!res.proposal?.id) throw new Error("No proposal was returned for this trade.");

    currentProposal = res.proposal;
    costEl.textContent = `${Number(res.proposal.ask_price ?? 0).toFixed(2)} ${getActiveCurrency()}`;
    payoutEl.textContent = res.proposal.payout != null ? `${Number(res.proposal.payout).toFixed(2)} ${getActiveCurrency()}` : "—";
    quoteResultEl.classList.remove("hidden");
  } catch (err) {
    currentProposal = null;
    tradeResultEl.textContent = err.message || "Could not price this trade.";
    tradeResultEl.classList.remove("hidden");
  }
}

function scheduleQuote() {
  if (proposalTimer) clearTimeout(proposalTimer);
  if (!AppState.selectedSymbol) return;
  proposalTimer = setTimeout(requestQuote, 350);
}

async function executeBuy(actionButton) {
  if (!currentProposal) {
    await requestQuote();
  }
  if (!currentProposal) return;

  actionButton.disabled = true;
  const original = actionButton.textContent;
  actionButton.textContent = "PLACING…";

  try {
    const res = await derivAPI.send({ buy: currentProposal.id, price: Number(currentProposal.ask_price) });
    if (!res.buy?.contract_id) throw new Error("Trade did not go through — no contract was returned.");
    tradeResultEl.textContent = `Trade placed — contract #${res.buy.contract_id}.`;
    tradeResultEl.classList.remove("hidden");
    quoteResultEl.classList.add("hidden");
    currentProposal = null;
  } catch (err) {
    tradeResultEl.textContent = err.message || "Trade failed.";
    tradeResultEl.classList.remove("hidden");
  } finally {
    actionButton.disabled = false;
    actionButton.textContent = original;
  }
}

tradeActionsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  setAction(btn.dataset.action);
  executeBuy(btn);
});

contractControlsEl.addEventListener("click", (event) => {
  const btn = event.target.closest(".trade-action-btn");
  if (!btn || currentFamily === "digits") return;
  setAction(btn.dataset.action);
  executeBuy(btn);
});

tradeTypeEl.addEventListener("change", renderControls);
[stakeEl, durationEl, durationUnitEl].forEach((el) => {
  el.addEventListener("input", () => { resetQuote(); scheduleQuote(); });
  el.addEventListener("change", () => { resetQuote(); scheduleQuote(); });
});

document.addEventListener("algotrade:symbol-selected", (e) => {
  tradePanelEl.classList.remove("hidden");
  miniMarketEl.textContent = e.detail.symbol;
  resetQuote();
  scheduleQuote();
});

// Initial state: Accumulators, matching the requested default terminal mode.
tradeTypeEl.value = "accumulators";
renderControls();
