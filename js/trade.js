// ==========================================================
// AlgoTrade — trade.js
// ==========================================================

let activeProposalId = null;

const contractTypeSelect = document.getElementById("trade-contract-type");
const digitRow = document.getElementById("trade-digit-row");
const durationInput = document.getElementById("trade-duration");
const durationUnitSelect = document.getElementById("trade-duration-unit");
const stakeInput = document.getElementById("trade-stake");
const quoteBtn = document.getElementById("trade-quote-btn");
const quoteResultBox = document.getElementById("trade-quote-result");
const payoutEl = document.getElementById("trade-payout");
const costEl = document.getElementById("trade-cost");
const buyBtn = document.getElementById("trade-buy-btn");
const resultBox = document.getElementById("trade-result");

if (contractTypeSelect) {
  contractTypeSelect.addEventListener("change", () => {
    const cType = contractTypeSelect.value;
    const isDigitMarket = cType.startsWith("DIGIT");

    if (isDigitMarket) {
      if (digitRow) digitRow.classList.remove("hidden");
      if (durationUnitSelect) durationUnitSelect.value = "t"; 
    } else {
      if (digitRow) digitRow.classList.add("hidden");
    }
  });
}

// 1. Get Price / Proposal
if (quoteBtn) {
  quoteBtn.addEventListener("click", async () => {
    if (!AppState.selectedSymbol) {
      alert("Please select a market symbol first.");
      return;
    }

    if (quoteResultBox) quoteResultBox.classList.add("hidden");
    if (resultBox) resultBox.classList.add("hidden");

    const contractType = contractTypeSelect.value;
    const stake = parseFloat(stakeInput.value);
    const duration = parseInt(durationInput.value, 10);
    const durationUnit = durationUnitSelect.value;
    const selectedDigit = parseInt(document.getElementById("trade-digit").value, 10);

    const proposalReq = {
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: contractType,
      currency: "USD",
      duration: duration,
      duration_unit: durationUnit,
      symbol: AppState.selectedSymbol,
    };

    if (contractType.startsWith("DIGIT")) {
      proposalReq.barrier = String(selectedDigit);
    }

    try {
      quoteBtn.textContent = "Calculating...";
      quoteBtn.disabled = true;

      const res = await derivAPI.send(proposalReq);

      if (res.error) {
        throw new Error(res.error.message);
      }

      if (res.proposal) {
        activeProposalId = res.proposal.id;
        if (payoutEl) payoutEl.textContent = `$${res.proposal.payout}`;
        if (costEl) costEl.textContent = `$${res.proposal.ask_price}`;
        if (quoteResultBox) quoteResultBox.classList.remove("hidden");
      }
    } catch (err) {
      if (resultBox) {
        resultBox.classList.remove("hidden");
        resultBox.className = "trade-result error";
        resultBox.textContent = `Proposal Error: ${err.message}`;
      }
    } finally {
      quoteBtn.textContent = "Get Proposal Quote";
      quoteBtn.disabled = false;
    }
  });
}

// 2. Execute Trade
if (buyBtn) {
  buyBtn.addEventListener("click", async () => {
    if (!activeProposalId) return;

    try {
      buyBtn.disabled = true;
      buyBtn.textContent = "Executing...";

      const res = await derivAPI.send({
        buy: activeProposalId,
        price: parseFloat(stakeInput.value),
      });

      if (res.error) {
        throw new Error(res.error.message);
      }

      if (resultBox) {
        resultBox.classList.remove("hidden");
        resultBox.className = "trade-result";
        resultBox.innerHTML = `<strong>Trade Placed!</strong><br>Contract ID: ${res.buy.contract_id}<br>Purchase Price: $${res.buy.buy_price}`;
      }

      if (quoteResultBox) quoteResultBox.classList.add("hidden");
      activeProposalId = null;
    } catch (err) {
      if (resultBox) {
        resultBox.classList.remove("hidden");
        resultBox.className = "trade-result error";
        resultBox.textContent = `Execution Error: ${err.message}`;
      }
    } finally {
      buyBtn.disabled = false;
      buyBtn.textContent = "Execute Trade Now";
    }
  });
}
