// ==========================================================
// AlgoTrade — digits.js
// Shows the last-digit distribution over the last 1,000 ticks for
// synthetic index markets (where Digits contracts — Matches/Differs,
// Over/Under — actually apply). Each digit 0-9 gets a circular
// percentage ring, and a small cursor sits under whichever digit the
// most recent tick ended in. Updates live as new ticks arrive.
// ==========================================================

const digitsWidgetEl = document.getElementById("digits-widget");
const digitsRowEl = document.getElementById("digits-row");

let digitHistory = []; // rolling window of last-digit values (0-9), most recent last
let unsubscribeDigitTicks = null;
let currentPipSize = 0.001;

function decimalPlacesFor(pipSize) {
  const str = String(pipSize);
  const dot = str.indexOf(".");
  return dot === -1 ? 0 : str.length - dot - 1;
}

function lastDigitOf(quote, pipSize) {
  const places = decimalPlacesFor(pipSize);
  const fixed = Number(quote).toFixed(places);
  return Number(fixed.slice(-1));
}

function computeCounts() {
  const counts = new Array(10).fill(0);
  digitHistory.forEach((d) => counts[d]++);
  return counts;
}

function renderDigits() {
  const total = digitHistory.length || 1;
  const counts = computeCounts();
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const lastDigit = digitHistory.length ? digitHistory[digitHistory.length - 1] : null;

  digitsRowEl.innerHTML = "";

  for (let d = 0; d <= 9; d++) {
    const pct = ((counts[d] / total) * 100);
    const pctLabel = pct.toFixed(1);

    const circumference = 2 * Math.PI * 18; // r=18
    const dashOffset = circumference - (pct / 100) * circumference;

    const isMax = counts[d] === max && max !== min;
    const isMin = counts[d] === min && max !== min;
    const ringColor = isMax ? "#2ECC8F" : isMin ? "#FF5C5C" : "#D4A94A";

    const cell = document.createElement("div");
    cell.className = "digit-cell";
    cell.innerHTML = `
      <svg viewBox="0 0 44 44" class="digit-ring">
        <circle cx="22" cy="22" r="18" class="digit-ring-bg" />
        <circle cx="22" cy="22" r="18" class="digit-ring-fg"
          stroke="${ringColor}"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${dashOffset}"
          transform="rotate(-90 22 22)" />
        <text x="22" y="27" class="digit-ring-text">${d}</text>
      </svg>
      <span class="digit-pct">${pctLabel}%</span>
      ${lastDigit === d ? '<span class="digit-cursor"></span>' : ""}
    `;
    digitsRowEl.appendChild(cell);
  }
}

async function loadDigitsFor(symbol, pipSize) {
  currentPipSize = pipSize || 0.001;
  digitHistory = [];

  if (unsubscribeDigitTicks) {
    unsubscribeDigitTicks();
    unsubscribeDigitTicks = null;
  }

  try {
    const res = await derivAPI.send({
      ticks_history: symbol,
      style: "ticks",
      count: 1000,
      end: "latest",
    });

    const prices = res.history?.prices || res.prices || [];
    digitHistory = prices.map((p) => lastDigitOf(p, currentPipSize));
    renderDigits();
  } catch (err) {
    console.error("Digit history failed:", err.message);
  }

  unsubscribeDigitTicks = derivAPI.subscribe({ ticks: symbol }, (data) => {
    if (!data.tick) return;
    digitHistory.push(lastDigitOf(data.tick.quote, currentPipSize));
    if (digitHistory.length > 1000) digitHistory.shift();
    renderDigits();
  });
}

document.addEventListener("algotrade:symbol-selected", (e) => {
  const meta = AppState.allSymbols.find((s) => s.symbol === e.detail.symbol);
  const isSynthetic = meta && meta.marketCode === "synthetic_index";

  digitsWidgetEl.classList.toggle("hidden", !isSynthetic);

  if (isSynthetic) {
    loadDigitsFor(e.detail.symbol, meta.pipSize);
  } else if (unsubscribeDigitTicks) {
    unsubscribeDigitTicks();
    unsubscribeDigitTicks = null;
  }
});
