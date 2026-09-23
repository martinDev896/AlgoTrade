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
let currentPipSize = 0.001;
let currentDigitsSymbol = null; // guards against stale ticks after switching markets
let digitsActive = false;       // only synthetic indices show/track this widget

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

let cellRefs = []; // persistent references to each digit's DOM pieces

function buildDigitCells() {
  digitsRowEl.innerHTML = "";
  cellRefs = [];

  for (let d = 0; d <= 9; d++) {
    const cell = document.createElement("div");
    cell.className = "digit-cell";
    cell.innerHTML = `
      <svg viewBox="0 0 44 44" class="digit-ring">
        <circle cx="22" cy="22" r="18" class="digit-ring-bg" />
        <circle cx="22" cy="22" r="18" class="digit-ring-fg" transform="rotate(-90 22 22)" />
        <text x="22" y="27" class="digit-ring-text">${d}</text>
      </svg>
      <span class="digit-pct">0.0%</span>
      <span class="digit-cursor hidden"></span>
    `;
    digitsRowEl.appendChild(cell);
    cellRefs.push({
      root: cell,
      ringFg: cell.querySelector(".digit-ring-fg"),
      pct: cell.querySelector(".digit-pct"),
      cursor: cell.querySelector(".digit-cursor"),
    });
  }
}

function renderDigits() {
  if (cellRefs.length !== 10) buildDigitCells();

  const total = digitHistory.length || 1;
  const counts = computeCounts();
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const lastDigit = digitHistory.length ? digitHistory[digitHistory.length - 1] : null;
  const circumference = 2 * Math.PI * 18; // r=18

  for (let d = 0; d <= 9; d++) {
    const pct = (counts[d] / total) * 100;
    const dashOffset = circumference - (pct / 100) * circumference;

    const isMax = counts[d] === max && max !== min;
    const isMin = counts[d] === min && max !== min;
    const ringColor = isMax ? "#2ECC8F" : isMin ? "#FF5C5C" : "#D4A94A";

    const ref = cellRefs[d];
    ref.ringFg.setAttribute("stroke", ringColor);
    ref.ringFg.setAttribute("stroke-dasharray", circumference);
    ref.ringFg.setAttribute("stroke-dashoffset", dashOffset);
    ref.pct.textContent = `${pct.toFixed(1)}%`;

    // Same DOM nodes persist across renders (not recreated), so toggling
    // this class actually animates via the CSS transition — the zoom
    // effect — instead of just snapping to its end state.
    const isActive = lastDigit === d;
    ref.root.classList.toggle("digit-cell-active", isActive);
    ref.cursor.classList.toggle("hidden", !isActive);
  }
}

async function loadDigitsFor(symbol, pipSize) {
  currentPipSize = pipSize || 0.001;
  currentDigitsSymbol = symbol;
  digitHistory = [];

  try {
    const res = await derivAPI.send({
      ticks_history: symbol,
      style: "ticks",
      count: 1000,
      end: "latest",
    });

    const prices = res.history?.prices || res.prices || [];
    // Only apply this if the user hasn't already switched markets while
    // this history request was in flight.
    if (currentDigitsSymbol === symbol) {
      digitHistory = prices.map((p) => lastDigitOf(p, currentPipSize));
      renderDigits();
    }
  } catch (err) {
    console.error("Digit history failed:", err.message);
  }
}

// Single shared listener for every live tick (broadcast by markets.js,
// which owns the one real ticks subscription per symbol — see the note
// in markets.js about why a second subscription silently fails).
document.addEventListener("algotrade:tick", (e) => {
  if (!digitsActive || e.detail.symbol !== currentDigitsSymbol) return;
  digitHistory.push(lastDigitOf(e.detail.quote, currentPipSize));
  if (digitHistory.length > 1000) digitHistory.shift();
  renderDigits();
});

document.addEventListener("algotrade:symbol-selected", (e) => {
  const meta = AppState.allSymbols.find((s) => s.symbol === e.detail.symbol);
  const isSynthetic = meta && meta.marketCode === "synthetic_index";

  digitsActive = isSynthetic;
  digitsWidgetEl.classList.toggle("hidden", !isSynthetic);

  if (isSynthetic) {
    loadDigitsFor(e.detail.symbol, meta.pipSize);
  } else {
    currentDigitsSymbol = null;
  }
});
