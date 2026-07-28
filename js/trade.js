// ==========================================================
// AlgoTrade — Dynamic trading panel
// Contract families: Accumulators, Rise/Fall, Higher/Lower,
// Touch/No Touch, Multipliers and Digits.
//
// This version keeps the existing OAuth/PKCE + authenticated
// WebSocket architecture and replaces the old "Get price"
// interaction with live proposal infomation and direct action
// buttons. Accumulators are monitored after purchase so the
// BUY button becomes CLOSE while the contract is active.
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
let selectedAction = "ACCU";
let currentFamily = "accumulators";
let activeAccumulator = null;
let accumulatorSubscription = null;
let accumulatorBusy = false;

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

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)} ${getActiveCurrency()}` : "—";
}

function ensureTradeLayout() {
  // Put the quote information immediately after the stake row and
  // the action buttons immediately after the quote. This lets the
  // existing HTML work without restoring a separate "Get price" button.
  if (!stakeEl || !quoteResultEl || !tradeActionsEl) return;
  const stakeRow = stakeEl.closest(".trade-row") || stakeEl.parentElement;
  if (stakeRow?.parentNode) stakeRow.parentNode.insertBefore(quoteResultEl, stakeRow.nextSibling);
  if (quoteResultEl.parentNode) quoteResultEl.parentNode.insertBefore(tradeActionsEl, quoteResultEl.nextSibling);

  // Hide the old cost line; users only need the payout information here.
  if (costEl) {
    const costRow = costEl.closest(".trade-row, .quote-row, .trade-quote-row");
    if (costRow) costRow.classList.add("hidden");
  }
}

function resetQuote({ keepResult = false } = {}) {
  currentProposal = null;
  if (quoteResultEl) quoteResultEl.classList.add("hidden");
  if (!keepResult && tradeResultEl) tradeResultEl.classList.add("hidden");
  if (proposalTimer) clearTimeout(proposalTimer);
}

function showResult(message, type = "success") {
  if (!tradeResultEl) return;
  tradeResultEl.textContent = message;
  tradeResultEl.classList.remove("hidden", "trade-error", "trade-success");
  tradeResultEl.classList.add(type === "error" ? "trade-error" : "trade-success");
}

function makeButton(label, action, className = "") {
  return `<button type="button" class="trade-action-btn ${className}" data-action="${action}">${label}</button>`;
}

function setPayout(value) {
  if (payoutEl) payoutEl.textContent = money(value);
  if (quoteResultEl) quoteResultEl.classList.remove("hidden");
}

function bindInputsForQuote() {
  contractControlsEl.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("input", () => { resetQuote(); scheduleQuote(); });
    el.addEventListener("change", () => { resetQuote(); scheduleQuote(); });
  });

  [stakeEl, durationEl, durationUnitEl].forEach((el) => {
    if (!el || el.dataset.tradeBound === "1") return;
    el.dataset.tradeBound = "1";
    el.addEventListener("input", () => { resetQuote(); scheduleQuote(); });
    el.addEventListener("change", () => { resetQuote(); scheduleQuote(); });
  });
}

function renderControls() {
  currentFamily = tradeTypeEl.value;
  titleEl.textContent = FAMILY_LABELS[currentFamily];
  resetQuote();
  tradeResultEl?.classList.add("hidden");

  if (currentFamily === "accumulators") {
    contractControlsEl.innerHTML = `
      <div class="trade-row">
        <label for="growth-rate">Growth rate</label>
        <select id="growth-rate" class="trade-select">
          <option value="0.01">1%</option>
          <option value="0.02">2%</option>
          <option value="0.03">3%</option>
          <option value="0.04">4%</option>
          <option value="0.05">5%</option>
        </select>
      </div>
      <div class="trade-row">
        <label for="accu-take-profit">Take profit <span class="optional-label">Optional</span></label>
        <input id="accu-take-profit" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="Enter amount" class="trade-input" />
      </div>
      <div class="trade-info">Max payout — 6000.00 USD</div>
    `;
    durationEl.value = 1;
    durationUnitEl.value = "t";
    durationEl.disabled = true;
    durationUnitEl.disabled = true;
    tradeActionsEl.innerHTML = makeButton(activeAccumulator ? "CLOSE" : "BUY ACCUMULATOR", activeAccumulator ? "CLOSE_ACCU" : "ACCU", activeAccumulator ? "action-close" : "trade-action-primary");
    selectedAction = "ACCU";
  } else if (currentFamily === "rise_fall") {
    contractControlsEl.innerHTML = "";
    tradeActionsEl.innerHTML = `<div class="trade-choice-grid two rise-fall-actions">${makeButton("▲ RISE", "CALL", "action-rise")}${makeButton("▼ FALL", "PUT", "action-fall")}</div>`;
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
    durationEl.disabled = true;
    durationUnitEl.disabled = true;
    tradeActionsEl.innerHTML = `<div class="trade-choice-grid two">${makeButton("BUY UP", "MULTUP", "action-rise")}${makeButton("BUY DOWN", "MULTDOWN", "action-fall")}</div>`;
    selectedAction = "MULTUP";
  } else if (currentFamily === "digits") {
    contractControlsEl.innerHTML = `
      <div class="trade-subsection-label">Trade type</div>
      <div class="trade-choice-grid two digit-group-tabs">
        ${makeButton("MATCHES", "DIGITMATCH", "digit-group-btn")}${makeButton("DIFFERS", "DIGITDIFF", "digit-group-btn")}
        ${makeButton("OVER", "DIGITOVER", "digit-group-btn")}${makeButton("UNDER", "DIGITUNDER", "digit-group-btn")}
        ${makeButton("EVEN", "DIGITEVEN", "digit-group-btn")}${makeButton("ODD", "DIGITODD", "digit-group-btn")}
      </div>
      <div class="trade-subsection-label digit-prediction-label">Last prediction digit</div>
      <div id="digit-keypad" class="digit-keypad">${Array.from({ length: 10 }, (_, d) => `<button type="button" class="digit-key${d === selectedDigit ? " selected" : ""}" data-digit="${d}">${d}</button>`).join("")}</div>
      <div class="selected-digit-summary">Prediction: <strong id="selected-digit-value">${selectedDigit}</strong></div>
    `;
    tradeActionsEl.innerHTML = `
      <div class="trade-choice-grid two digit-buy-actions">
        ${makeButton("MATCHES", "DIGITMATCH", "action-rise")}
        ${makeButton("DIFFERS", "DIGITDIFF", "action-fall")}
      </div>
    `;
    selectedAction = selectedDigitContract;
    updateDigitGroupUI();

    contractControlsEl.querySelectorAll(".digit-group-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedDigitContract = btn.dataset.action;
        selectedAction = selectedDigitContract;
        updateDigitGroupUI();
        resetQuote();
        scheduleQuote();
      });
    });

    contractControlsEl.querySelectorAll(".digit-key").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedDigit = Number(btn.dataset.digit);
        contractControlsEl.querySelectorAll(".digit-key").forEach((b) => b.classList.toggle("selected", b === btn));
        const summary = document.getElementById("selected-digit-value");
        if (summary) summary.textContent = selectedDigit;
        resetQuote();
        scheduleQuote();
      });
    });
  }

  if (currentFamily !== "accumulators" && currentFamily !== "multipliers") {
    durationEl.disabled = false;
    durationUnitEl.disabled = false;
  }

  bindInputsForQuote();
  updatePayoutPlaceholder();
  scheduleQuote();
}

function updateDigitGroupUI() {
  const groups = {
    DIGITMATCH: ["DIGITMATCH", "DIGITDIFF"],
    DIGITDIFF: ["DIGITMATCH", "DIGITDIFF"],
    DIGITOVER: ["DIGITOVER", "DIGITUNDER"],
    DIGITUNDER: ["DIGITOVER", "DIGITUNDER"],
    DIGITEVEN: ["DIGITEVEN", "DIGITODD"],
    DIGITODD: ["DIGITEVEN", "DIGITODD"],
  };
  const pair = groups[selectedDigitContract] || groups.DIGITMATCH;
  const buttons = [...contractControlsEl.querySelectorAll(".digit-group-btn")];
  buttons.forEach((b) => b.classList.toggle("active", b.dataset.action === selectedDigitContract));

  const buyButtons = [...tradeActionsEl.querySelectorAll("button[data-action]")];
  buyButtons.forEach((b) => {
    const action = b.dataset.action;
    const isPair = pair.includes(action);
    b.classList.toggle("hidden", !isPair);
    b.classList.toggle("active", action === selectedDigitContract);
    b.textContent = action.replace("DIGIT", "");
  });
}

function updatePayoutPlaceholder() {
  if (!payoutEl) return;
  if (currentFamily === "accumulators") {
    payoutEl.textContent = "—";
    quoteResultEl?.classList.add("hidden");
    return;
  }
  payoutEl.textContent = "Pricing…";
}

function buildProposalRequest() {
  const symbol = AppState.selectedSymbol;
  if (!symbol || !selectedAction || selectedAction === "CLOSE_ACCU") return null;

  const amount = Number(stakeEl.value);
  if (!Number.isFinite(amount) || amount < 1) throw new Error("Stake must be at least 1.00 USD.");

  const request = {
    proposal: 1,
    amount,
    basis: "stake",
    contract_type: selectedAction,
    currency: getActiveCurrency(),
    underlying_symbol: symbol,
  };

  if (currentFamily !== "multipliers" && currentFamily !== "accumulators") {
    const duration = Number(durationEl.value);
    if (!Number.isFinite(duration) || duration < 1) throw new Error("Enter a valid duration.");
    request.duration = duration;
    request.duration_unit = durationUnitEl.value;
  }

  if (currentFamily === "accumulators") {
    const growthRate = Number(document.getElementById("growth-rate")?.value || 0.01);
    request.growth_rate = growthRate;

    const takeProfit = Number(document.getElementById("accu-take-profit")?.value || 0);
    if (takeProfit > 0) {
      request.limit_order = { take_profit: takeProfit };
    }
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
  if (!AppState.selectedSymbol || activeAccumulator) return;
  try {
    const request = buildProposalRequest();
    if (!request) return;
    const res = await derivAPI.send(request);
    if (!res.proposal?.id) throw new Error("No proposal was returned for this trade.");

    currentProposal = res.proposal;
    if (costEl) costEl.textContent = money(res.proposal.ask_price);

    // For binary/digit/multiplier contracts, show the payout as the
    // only information line between stake and the action buttons.
    if (currentFamily !== "accumulators") {
      setPayout(res.proposal.payout);
    }
  } catch (err) {
    currentProposal = null;
    if (quoteResultEl) quoteResultEl.classList.add("hidden");
    showResult(err.message || "Could not price this trade.", "error");
  }
}

function scheduleQuote() {
  if (proposalTimer) clearTimeout(proposalTimer);
  if (!AppState.selectedSymbol || activeAccumulator) return;
  proposalTimer = setTimeout(requestQuote, 350);
}

function setAction(action) {
  selectedAction = action;
  if (currentFamily === "digits") selectedDigitContract = action;
  tradeActionsEl.querySelectorAll("button[data-action]").forEach((b) => b.classList.toggle("active", b.dataset.action === action));
  if (currentFamily === "digits") updateDigitGroupUI();
  resetQuote();
  scheduleQuote();
}

async function executeBuy(actionButton) {
  if (accumulatorBusy || activeAccumulator) return;

  if (!currentProposal) await requestQuote();
  if (!currentProposal) return;

  accumulatorBusy = true;
  actionButton.disabled = true;
  const original = actionButton.textContent;
  actionButton.textContent = "PLACING…";

  try {
    const res = await derivAPI.send({ buy: currentProposal.id, price: Number(currentProposal.ask_price) });
    if (!res.buy?.contract_id) throw new Error("Trade did not go through — no contract was returned.");

    const contractId = res.buy.contract_id;
    showResult(`Trade placed — contract #${contractId}.`, "success");
    currentProposal = null;
    quoteResultEl?.classList.add("hidden");

    if (currentFamily === "accumulators") {
      activeAccumulator = { contractId };
      await subscribeToAccumulator(contractId);
      renderControls();
    }
  } catch (err) {
    showResult(err.message || "Trade failed.", "error");
  } finally {
    accumulatorBusy = false;
    actionButton.disabled = false;
    actionButton.textContent = original;
  }
}

async function subscribeToAccumulator(contractId) {
  if (accumulatorSubscription) {
    accumulatorSubscription();
    accumulatorSubscription = null;
  }

  accumulatorSubscription = derivAPI.subscribe({
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 1,
  }, (data) => {
    const contract = data.proposal_open_contract;
    if (!contract) return;

    activeAccumulator = {
      contractId,
      bidPrice: Number(contract.bid_price || 0),
      profit: Number(contract.profit || 0),
      payout: Number(contract.payout || 0),
      status: contract.status,
      isSold: !!contract.is_sold,
    };

    if (contract.is_sold || contract.status === "sold") {
      const finalProfit = Number(contract.profit || 0);
      showResult(`Accumulator closed. Profit: ${money(finalProfit)}.`, finalProfit >= 0 ? "success" : "error");
      clearAccumulatorState();
      return;
    }

    renderAccumulatorLiveState();
  });
}

function renderAccumulatorLiveState() {
  if (currentFamily !== "accumulators" || !activeAccumulator) return;
  const live = activeAccumulator;
  if (payoutEl) payoutEl.textContent = `Current value: ${money(live.bidPrice)}`;
  quoteResultEl?.classList.remove("hidden");

  tradeActionsEl.innerHTML = makeButton("CLOSE", "CLOSE_ACCU", "action-close");
}

async function closeAccumulator() {
  if (!activeAccumulator || accumulatorBusy) return;
  accumulatorBusy = true;

  const button = tradeActionsEl.querySelector('[data-action="CLOSE_ACCU"]');
  if (button) {
    button.disabled = true;
    button.textContent = "CLOSING…";
  }

  try {
    // price: 0 means sell at market according to the current Deriv API.
    const res = await derivAPI.send({ sell: activeAccumulator.contractId, price: 0 });
    if (!res.sell?.sold_for && !res.sell?.transaction_id && !res.sell?.contract_id) {
      // Some responses expose different sell fields; a successful response
      // is still accepted when no error is returned.
    }
    showResult(`Accumulator closed — contract #${activeAccumulator.contractId}.`, "success");
    clearAccumulatorState();
  } catch (err) {
    showResult(err.message || "Could not close the accumulator.", "error");
    if (button) {
      button.disabled = false;
      button.textContent = "CLOSE";
    }
  } finally {
    accumulatorBusy = false;
  }
}

function clearAccumulatorState() {
  if (accumulatorSubscription) {
    accumulatorSubscription();
    accumulatorSubscription = null;
  }
  activeAccumulator = null;
  currentProposal = null;
  quoteResultEl?.classList.add("hidden");
  renderControls();
}

tradeActionsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  if (action === "CLOSE_ACCU") {
    closeAccumulator();
    return;
  }

  setAction(action);
  executeBuy(btn);
});

tradeTypeEl.addEventListener("change", () => {
  if (activeAccumulator) {
    showResult("Close the active accumulator before changing trade type.", "error");
    tradeTypeEl.value = "accumulators";
    return;
  }
  renderControls();
});

document.addEventListener("algotrade:symbol-selected", (e) => {
  // Never leave an active accumulator attached to a different market.
  if (activeAccumulator) {
    showResult("An accumulator is active. Close it before switching markets.", "error");
    return;
  }
  tradePanelEl.classList.remove("hidden");
  miniMarketEl.textContent = e.detail.symbol;
  resetQuote();
  scheduleQuote();
});

document.addEventListener("algotrade:account-ready", () => {
  ensureTradeLayout();
});

ensureTradeLayout();
tradeTypeEl.value = "accumulators";
renderControls();
