// ==========================================================
// AlgoTrade — Digits
// Last-digit distribution over the latest 1,000 ticks.
// The green triangular cursor is positioned directly beneath the
// digit circle corresponding to the latest market-price digit.
// ==========================================================

const digitsWidgetEl = document.getElementById("digits-widget");
const digitsRowEl = document.getElementById("digits-row");

let digitHistory = [];
let unsubscribeDigitTicks = null;
let currentPipSize = 0.001;

function decimalPlacesFor(pipSize) {
  const value = Number(pipSize);
  if (!Number.isFinite(value) || value <= 0) return 3;
  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
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
    const pct = (counts[d] / total) * 100;
    const circumference = 2 * Math.PI * 18;
    const dashOffset = circumference - (pct / 100) * circumference;
    const isMax = counts[d] === max && max !== min;
    const isMin = counts[d] === min && max !== min;
    const ringColor = isMax ? "#2ECC8F" : isMin ? "#FF5C5C" : "#D4A94A";

    const cell = document.createElement("div");
    cell.className = "digit-cell";
    cell.innerHTML = `
      <div class="digit-ring-wrap">
        <svg viewBox="0 0 44 44" class="digit-ring" aria-label="Digit ${d}">
          <circle cx="22" cy="22" r="18" class="digit-ring-bg" />
          <circle cx="22" cy="22" r="18" class="digit-ring-fg"
            stroke="${ringColor}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${dashOffset}"
            transform="rotate(-90 22 22)" />
          <text x="22" y="27" class="digit-ring-text">${d}</text>
        </svg>
        ${lastDigit === d ? '<span class="digit-cursor" aria-label="Current last digit"></span>' : ""}
      </div>
      <span class="digit-pct">${pct.toFixed(1)}%</span>
    `;
    digitsRowEl.appendChild(cell);
  }
}

async function loadDigitsFor(symbol, pipSize) {
  currentPipSize = pipSize || 0.001;
  digitHistory = [];
  renderDigits();

  if (unsubscribeDigitTicks) {
    await unsubscribeDigitTicks();
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
    digitHistory = prices.map((p) => lastDigitOf(p, currentPipSize)).slice(-1000);
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
