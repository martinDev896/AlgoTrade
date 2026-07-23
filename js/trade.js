// ==========================================================
// AlgoTrade — trade.js
// Rise/Fall and Digits (Matches/Differs, Over/Under) trading.
//
// Flow: pick contract + duration + stake -> "Get price" sends a
// one-off `proposal` request -> shows payout -> "Buy" sends `buy`
// with that proposal's id and price to actually execute the trade
// on Deriv's servers under the active account.
// ==========================================================

const GREEN_CONTRACTS = ["CALL", "DIGITMATCH", "DIGITOVER"];
const RED_CONTRACTS = ["PUT", "DIGITDIFF", "DIGITUNDER"];

const tradePanelEl        = document.getElementById("trade-panel");
const typeTabEls          = document.querySelectorAll(".trade-type-tab");
const riseFallRowEl       = document.getElementById("rise-fall-row");
const digitRowEl          = document.getElementById("trade-digit-row");
const directionBtns       = document.querySelectorAll(".btn-direction");
const digitContractSelect = document.getElementById("digit-contract-select");
const digitValueSelect    = document.getElementById("trade-digit");
const durationEl          = document.getElementById("trade-duration");
const durationUnitEl      = document.getElementById("trade-duration-unit");
const stakeEl             = document.getElementById("trade-stake");
const quoteBtn            = document.getElementById("trade-quote-btn");
const quoteResultEl       = document.getElementById("trade-quote-result");
const payoutEl            = document.getElementById("trade-payout");
const costEl              = document.getElementById("trade-cost");
const buyBtn              = document.getElementById("trade-buy-btn");
const tradeResultEl       = document.getElementById("trade-result");

let activeGroup = "rise_fall";       // "rise_fall" | "digits"
let activeDirection = "CALL";        // for rise/fall buttons
let currentProposal = null;          // { id, ask_price, payout }

// Populate the digit value dropdown (0-9) once.
for (let d = 0; d <= 9; d++) {
  const opt = document.createElement("option");
  opt.value = d;
  opt.textContent = d;
  digitValueSelect.appendChild(opt);
}

function currentContractType() {
  return activeGroup === "rise_fall" ? activeDirection : digitContractSelect.value;
}

function updateButtonColors() {
  const type = currentContractType();
  const isGreen = GREEN_CONTRACTS.includes(type);
  quoteBtn.classList.toggle("btn-quote-green", isGreen);
  quoteBtn.classList.toggle("btn-quote-red", !isGreen);
  buyBtn.classList.toggle("btn-buy-green", isGreen);
  buyBtn.classList.toggle("btn-buy-red", !isGreen);
}

// ---- Rise/Fall vs Digits tab switching ----
typeTabEls.forEach((tab) => {
  tab.addEventListener("click", () => {
    typeTabEls.forEach((t) => t.classList.toggle("active", t === tab));
    activeGroup = tab.dataset.group;
    riseFallRowEl.classList.toggle("hidden", activeGroup !== "rise_fall");
    digitRowEl.classList.toggle("hidden", activeGroup !== "digits");
    updateButtonColors();
    resetQuote();
  });
});

// ---- Rise / Fall direction buttons ----
directionBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    directionBtns.forEach((b) => b.classList.toggle("active", b === btn));
    activeDirection = btn.dataset.contract;
    updateButtonColors();
    resetQuote();
  });
});

digitContractSelect.addEventListener("change", () => {
  updateButtonColors();
  resetQuote();
});

function getActiveCurrency() {
  const acct = AppState.accounts.find((a) => a.account_id === AppState.activeAccountId);
  return acct ? acct.currency : "USD";
}

function resetQuote() {
  currentProposal = null;
  quoteResultEl.classList.add("hidden");
  tradeResultEl.classList.add("hidden");
}

async function requestQuote() {
  if (!AppState.selectedSymbol) {
    tradeResultEl.textContent = "Pick a market first.";
    tradeResultEl.classList.remove("hidden");
    return;
  }

  resetQuote();
  quoteBtn.disabled = true;
  quoteBtn.textContent = "Getting price…";

  const contractType = currentContractType();
  const request = {
    proposal: 1,
    amount: parseFloat(stakeEl.value),
    basis: "stake",
    contract_type: contractType,
    currency: getActiveCurrency(),
    underlying_symbol: AppState.selectedSymbol,
    duration: parseInt(durationEl.value, 10),
    duration_unit: durationUnitEl.value,
  };

  if (activeGroup === "digits") {
    request.barrier = digitValueSelect.value;
  }

  try {
    const res = await derivAPI.send(request);
    if (!res.proposal || !res.proposal.id) {
      throw new Error("No price returned for this combination.");
    }
    currentProposal = res.proposal;
    payoutEl.textContent = `${Number(currentProposal.payout).toFixed(2)} ${getActiveCurrency()}`;
    costEl.textContent = `${Number(currentProposal.ask_price).toFixed(2)} ${getActiveCurrency()}`;
    quoteResultEl.classList.remove("hidden");
  } catch (err) {
    tradeResultEl.textContent = err.message || "Could not get a price for this trade.";
    tradeResultEl.classList.remove("hidden");
  } finally {
    quoteBtn.disabled = false;
    quoteBtn.textContent = "Get price";
  }
}

async function executeBuy() {
  if (!currentProposal) return;

  buyBtn.disabled = true;
  buyBtn.textContent = "Placing trade…";

  try {
    const res = await derivAPI.send({
      buy: currentProposal.id,
      price: currentProposal.ask_price,
    });

    if (!res.buy || !res.buy.contract_id) {
      throw new Error("Trade did not go through — no contract was returned.");
    }

    tradeResultEl.textContent = `Trade placed — contract #${res.buy.contract_id}. Track it on your Deriv dashboard.`;
    tradeResultEl.classList.remove("hidden");
    quoteResultEl.classList.add("hidden");
    currentProposal = null;
  } catch (err) {
    tradeResultEl.textContent = err.message || "Trade failed.";
    tradeResultEl.classList.remove("hidden");
  } finally {
    buyBtn.disabled = false;
    buyBtn.textContent = "Buy";
  }
}

quoteBtn.addEventListener("click", requestQuote);
buyBtn.addEventListener("click", executeBuy);

updateButtonColors();

// Show the trade panel once a market is selected.
document.addEventListener("algotrade:symbol-selected", () => {
  tradePanelEl.classList.remove("hidden");
  resetQuote();
});
