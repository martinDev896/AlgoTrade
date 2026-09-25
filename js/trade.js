// ==========================================================
// AlgoTrade — trade.js
// Rise/Fall, Digits (Matches/Differs, Over/Under), and Accumulators.
//
// New behavior: no more "Get price" click. Each buy button keeps a
// LIVE proposal subscription running in the background (payout updates
// automatically as the market moves or inputs change) and buys
// immediately using whatever proposal is currently cached — the same
// pattern Deriv's own site uses.
// ==========================================================

const tradePanelEl        = document.getElementById("trade-panel");
const typeTabEls          = document.querySelectorAll(".trade-type-tab");
const riseFallRowEl       = document.getElementById("rise-fall-row");
const digitRowEl          = document.getElementById("trade-digit-row");
const digitContractSelect = document.getElementById("digit-contract-select");
const digitValueSelect    = document.getElementById("trade-digit");
const durationFieldsEl    = document.getElementById("duration-fields");
const durationEl          = document.getElementById("trade-duration");
const durationUnitEl      = document.getElementById("trade-duration-unit");
const stakeEl              = document.getElementById("trade-stake");
const accumulatorFieldsEl = document.getElementById("accumulator-fields");
const growthRateRowEl     = document.getElementById("growth-rate-row");
const takeProfitToggleEl  = document.getElementById("take-profit-toggle");
const takeProfitValueEl   = document.getElementById("take-profit-value");
const digitBuyBtn         = document.getElementById("digit-buy-btn");
const accuBuyBtn          = document.getElementById("accu-buy-btn");
const tradeResultEl       = document.getElementById("trade-result");

let activeGroup = "rise_fall";   // "rise_fall" | "digits" | "accumulators"
let growthRate = 0.01;           // accumulators: 1%-5%
let refreshTimer = null;

// contractType -> { unsubscribe, proposal: {id, ask_price, payout} | null }
let liveProposals = {};

// Populate the digit value dropdown (0-9) once.
for (let d = 0; d <= 9; d++) {
  const opt = document.createElement("option");
  opt.value = d;
  opt.textContent = d;
  digitValueSelect.appendChild(opt);
}

function getActiveCurrency() {
  const acct = AppState.accounts.find((a) => a.account_id === AppState.activeAccountId);
  return acct ? acct.currency : "USD";
}

// ==========================================================
// Live proposal subscriptions
// ==========================================================

function buildProposalRequest(contractType) {
  const req = {
    proposal: 1,
    amount: parseFloat(stakeEl.value) || 0,
    basis: "stake",
    contract_type: contractType,
    currency: getActiveCurrency(),
    underlying_symbol: AppState.selectedSymbol,
  };

  if (activeGroup === "accumulators") {
    req.growth_rate = growthRate;
    if (takeProfitToggleEl.checked && parseFloat(takeProfitValueEl.value) > 0) {
      req.limit_order = { take_profit: parseFloat(takeProfitValueEl.value) };
    }
  } else {
    req.duration = parseInt(durationEl.value, 10);
    req.duration_unit = durationUnitEl.value;
    if (activeGroup === "digits") {
      req.barrier = digitValueSelect.value;
    }
  }

  return req;
}

function setButtonPayout(btn, text, enabled) {
  const payoutEl = btn.querySelector(".btn-direction-payout");
  if (payoutEl) payoutEl.textContent = text;
  btn.disabled = !enabled;
}

function stopLiveProposal(contractType) {
  const entry = liveProposals[contractType];
  if (entry && entry.unsubscribe) entry.unsubscribe();
  delete liveProposals[contractType];
}

function stopAllLiveProposals() {
  Object.keys(liveProposals).forEach(stopLiveProposal);
}

function startLiveProposal(contractType, btn) {
  stopLiveProposal(contractType);

  if (!AppState.selectedSymbol || !parseFloat(stakeEl.value)) {
    setButtonPayout(btn, "—", false);
    return;
  }

  setButtonPayout(btn, "…", false);

  const unsubscribe = derivAPI.subscribe(buildProposalRequest(contractType), (data) => {
    if (data.error) {
      liveProposals[contractType] = { unsubscribe, proposal: null };
      setButtonPayout(btn, "N/A", false);
      return;
    }
    if (data.proposal) {
      liveProposals[contractType] = { unsubscribe, proposal: data.proposal };
      const currency = getActiveCurrency();
      setButtonPayout(btn, `${Number(data.proposal.payout).toFixed(2)} ${currency}`, true);
    }
  });

  liveProposals[contractType] = { unsubscribe, proposal: null };
}

// Re-subscribes whatever buttons are visible for the current group.
// Debounced so rapid input changes (typing a stake) don't spam Deriv
// with a fresh subscription on every keystroke.
function refreshLiveProposals() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    stopAllLiveProposals();
    tradeResultEl.classList.add("hidden");

    if (activeGroup === "rise_fall") {
      startLiveProposal("CALL", riseFallRowEl.querySelector('[data-contract="CALL"]'));
      startLiveProposal("PUT", riseFallRowEl.querySelector('[data-contract="PUT"]'));
    } else if (activeGroup === "digits") {
      startLiveProposal(digitContractSelect.value, digitBuyBtn);
    } else if (activeGroup === "accumulators") {
      startLiveProposal("ACCU", accuBuyBtn);
    }
  }, 400);
}

// ==========================================================
// Buying
// ==========================================================

async function buyContract(contractType, btn) {
  const entry = liveProposals[contractType];
  if (!entry || !entry.proposal) return;

  const originalLabel = btn.querySelector(".btn-direction-label").textContent;
  btn.disabled = true;
  btn.querySelector(".btn-direction-label").textContent = "Placing…";

  try {
    const res = await derivAPI.send({
      buy: entry.proposal.id,
      price: entry.proposal.ask_price,
    });

    if (!res.buy || !res.buy.contract_id) {
      throw new Error("Trade did not go through — no contract was returned.");
    }

    tradeResultEl.textContent = `Trade placed — contract #${res.buy.contract_id}.`;
    tradeResultEl.classList.remove("hidden");
  } catch (err) {
    tradeResultEl.textContent = err.message || "Trade failed.";
    tradeResultEl.classList.remove("hidden");
  } finally {
    btn.querySelector(".btn-direction-label").textContent = originalLabel;
    // The live subscription's next push will re-enable the button.
  }
}

riseFallRowEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-direction");
  if (btn) buyContract(btn.dataset.contract, btn);
});

digitBuyBtn.addEventListener("click", () => {
  buyContract(digitContractSelect.value, digitBuyBtn);
});

accuBuyBtn.addEventListener("click", () => {
  buyContract("ACCU", accuBuyBtn);
});

// ==========================================================
// Trade type tabs (Rise/Fall vs Digits vs Accumulators)
// ==========================================================

typeTabEls.forEach((tab) => {
  tab.addEventListener("click", () => {
    typeTabEls.forEach((t) => t.classList.toggle("active", t === tab));
    activeGroup = tab.dataset.group;

    riseFallRowEl.classList.toggle("hidden", activeGroup !== "rise_fall");
    digitRowEl.classList.toggle("hidden", activeGroup !== "digits");
    digitBuyBtn.classList.toggle("hidden", activeGroup !== "digits");
    accumulatorFieldsEl.classList.toggle("hidden", activeGroup !== "accumulators");
    accuBuyBtn.classList.toggle("hidden", activeGroup !== "accumulators");
    durationFieldsEl.classList.toggle("hidden", activeGroup === "accumulators");

    refreshLiveProposals();
  });
});

const DIGIT_LABELS = { DIGITMATCH: "Buy Matches", DIGITDIFF: "Buy Differs", DIGITOVER: "Buy Over", DIGITUNDER: "Buy Under" };

digitContractSelect.addEventListener("change", () => {
  digitBuyBtn.dataset.contract = digitContractSelect.value;
  digitBuyBtn.querySelector(".btn-direction-label").textContent = DIGIT_LABELS[digitContractSelect.value];
  refreshLiveProposals();
});

digitValueSelect.addEventListener("change", refreshLiveProposals);
durationEl.addEventListener("input", refreshLiveProposals);
durationUnitEl.addEventListener("change", refreshLiveProposals);
stakeEl.addEventListener("input", refreshLiveProposals);

// ---- Accumulators-specific controls ----
growthRateRowEl.querySelectorAll(".growth-rate-btn").forEach((btn) => {
  if (btn.dataset.rate === "0.01") btn.classList.add("active");
  btn.addEventListener("click", () => {
    growthRateRowEl.querySelectorAll(".growth-rate-btn").forEach((b) => b.classList.toggle("active", b === btn));
    growthRate = parseFloat(btn.dataset.rate);
    refreshLiveProposals();
  });
});

takeProfitToggleEl.addEventListener("change", () => {
  takeProfitValueEl.classList.toggle("hidden", !takeProfitToggleEl.checked);
  refreshLiveProposals();
});

takeProfitValueEl.addEventListener("input", refreshLiveProposals);

// Show the trade panel and start live pricing once a market is selected.
document.addEventListener("algotrade:symbol-selected", () => {
  digitBuyBtn.querySelector(".btn-direction-label").textContent = DIGIT_LABELS[digitContractSelect.value];
  tradePanelEl.classList.remove("hidden");
  refreshLiveProposals();
});
