// ==========================================================
// AlgoTrade — trade.js
// Rise/Fall, Digits (Matches/Differs, Over/Under, Even/Odd), and
// Accumulators.
//
// Rise/Fall and every Digits pair share ONE reusable pair of buttons
// (#dual-btn-a / #dual-btn-b) — only the labels, colors, and contract
// types change between them. Each button keeps a LIVE proposal
// subscription running (payout updates automatically) and buys
// immediately on click, using whatever proposal is currently cached.
// Accumulators has no opposite side, so it keeps its own single button.
// ==========================================================

const tradePanelEl        = document.getElementById("trade-panel");
const typeTabEls          = document.querySelectorAll(".trade-type-tab");
const digitPairTabsEl     = document.getElementById("digit-pair-tabs");
const digitValueRowEl     = document.getElementById("digit-value-row");
const digitValueSelect    = document.getElementById("trade-digit");
const durationFieldsEl    = document.getElementById("duration-fields");
const durationEl          = document.getElementById("trade-duration");
const durationUnitEl      = document.getElementById("trade-duration-unit");
const stakeEl             = document.getElementById("trade-stake");
const accumulatorFieldsEl = document.getElementById("accumulator-fields");
const growthRateRowEl     = document.getElementById("growth-rate-row");
const takeProfitToggleEl  = document.getElementById("take-profit-toggle");
const takeProfitValueEl   = document.getElementById("take-profit-value");
const dualButtonRowEl     = document.getElementById("dual-button-row");
const dualBtnA            = document.getElementById("dual-btn-a");
const dualBtnB            = document.getElementById("dual-btn-b");
const accuBuyBtn          = document.getElementById("accu-buy-btn");
const tradeResultEl       = document.getElementById("trade-result");

let activeGroup = "rise_fall";   // "rise_fall" | "digits" | "accumulators"
let activePair = "matches_differs"; // digits sub-selection
let growthRate = 0.01;
let refreshTimer = null;

// contractType -> { unsubscribe, proposal: {id, ask_price, payout} | null }
let liveProposals = {};

// Every pair of opposite contract types the dual buttons can show.
// "rise_fall" isn't listed here since it's the default already in the HTML.
const DIGIT_PAIRS = {
  matches_differs: [
    { contract: "DIGITMATCH", label: "Matches", side: "rise" },
    { contract: "DIGITDIFF", label: "Differs", side: "fall" },
  ],
  over_under: [
    { contract: "DIGITOVER", label: "Over", side: "rise" },
    { contract: "DIGITUNDER", label: "Under", side: "fall" },
  ],
  even_odd: [
    { contract: "DIGITEVEN", label: "Even", side: "rise" },
    { contract: "DIGITODD", label: "Odd", side: "fall" },
  ],
};

const RISE_FALL_PAIR = [
  { contract: "CALL", label: "▲ Rise", side: "rise" },
  { contract: "PUT", label: "▼ Fall", side: "fall" },
];

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

function currentPair() {
  return activeGroup === "digits" ? DIGIT_PAIRS[activePair] : RISE_FALL_PAIR;
}

// Applies the current pair's labels/colors/contract types onto the one
// shared pair of buttons.
function renderDualButtons() {
  const [a, b] = currentPair();

  dualBtnA.dataset.contract = a.contract;
  dualBtnA.querySelector(".btn-direction-label").textContent = a.label;
  dualBtnA.className = `btn-direction ${a.side === "rise" ? "btn-rise" : "btn-fall"}`;

  dualBtnB.dataset.contract = b.contract;
  dualBtnB.querySelector(".btn-direction-label").textContent = b.label;
  dualBtnB.className = `btn-direction ${b.side === "rise" ? "btn-rise" : "btn-fall"}`;
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
    // Even/Odd needs no barrier — only Matches/Differs/Over/Under do.
    if (activeGroup === "digits" && activePair !== "even_odd") {
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

// Re-subscribes whatever buttons are visible for the current group/pair.
// Debounced so rapid input changes (typing a stake) don't spam Deriv
// with a fresh subscription on every keystroke.
function refreshLiveProposals() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    stopAllLiveProposals();
    tradeResultEl.classList.add("hidden");

    if (activeGroup === "accumulators") {
      startLiveProposal("ACCU", accuBuyBtn);
    } else {
      renderDualButtons();
      const [a, b] = currentPair();
      startLiveProposal(a.contract, dualBtnA);
      startLiveProposal(b.contract, dualBtnB);
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
    // Don't rely on the old subscription to push again on its own —
    // it can go quiet right after its proposal is used to buy. Start a
    // fresh one so the button re-enables with a current payout.
    startLiveProposal(contractType, btn);
  }
}

dualButtonRowEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-direction");
  if (btn) buyContract(btn.dataset.contract, btn);
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

    digitPairTabsEl.classList.toggle("hidden", activeGroup !== "digits");
    digitValueRowEl.classList.toggle("hidden", !(activeGroup === "digits" && activePair !== "even_odd"));
    accumulatorFieldsEl.classList.toggle("hidden", activeGroup !== "accumulators");
    accuBuyBtn.classList.toggle("hidden", activeGroup !== "accumulators");
    dualButtonRowEl.classList.toggle("hidden", activeGroup === "accumulators");
    durationFieldsEl.classList.toggle("hidden", activeGroup === "accumulators");

    refreshLiveProposals();
  });
});

// ---- Digits pair selector (Matches/Differs, Over/Under, Even/Odd) ----
digitPairTabsEl.querySelectorAll(".pair-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    digitPairTabsEl.querySelectorAll(".pair-tab").forEach((t) => t.classList.toggle("active", t === tab));
    activePair = tab.dataset.pair;
    digitValueRowEl.classList.toggle("hidden", activePair === "even_odd");
    refreshLiveProposals();
  });
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
  tradePanelEl.classList.remove("hidden");
  refreshLiveProposals();
});
