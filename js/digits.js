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

// The currently open digit contract, if any — drives win/lose coloring.
// { contractType, barrier, winSet: Set<number> } | null
let activeContract = null;

const RISE_GREEN = "#2ECC8F";
const FALL_RED = "#FF5C5C";

// Which digits 0-9 currently count as a win for a given digit contract.
function computeWinSet(contractType, barrier) {
  const n = barrier === null || barrier === undefined ? null : Number(barrier);
  const win = new Set();
  for (let d = 0; d <= 9; d++) {
    let isWin;
    switch (contractType) {
      case "DIGITMATCH": isWin = d === n; break;
      case "DIGITDIFF": isWin = d !== n; break;
      case "DIGITOVER": isWin = d > n; break;
      case "DIGITUNDER": isWin = d < n; break;
      case "DIGITEVEN": isWin = d % 2 === 0; break;
      case "DIGITODD": isWin = d % 2 === 1; break;
      default: isWin = false;
    }
    if (isWin) win.add(d);
  }
  return win;
}

// For tick-duration contracts, counted locally off the same tick stream
// that moves the cursor — see the "algotrade:tick" listener below for why.
let ticksUntilExpiry = null;

document.addEventListener("algotrade:digit-contract-active", (e) => {
  const { contractType, barrier, duration, durationUnit } = e.detail;
  activeContract = { contractType, barrier, winSet: computeWinSet(contractType, barrier) };
  ticksUntilExpiry = durationUnit === "t" ? duration : null;
  renderDigits();
});

document.addEventListener("algotrade:digit-contract-ended", () => {
  activeContract = null;
  ticksUntilExpiry = null;
  renderDigits();
});

function buildDigitCells() {
  digitsRowEl.innerHTML = "";
  cellRefs = [];

  for (let d = 0; d <= 9; d++) {
    const cell = document.createElement("div");
    cell.className = "digit-cell";
    cell.innerHTML = `
      <svg viewBox="0 0 44 44" class="digit-ring">
        <circle cx="22" cy="22" r="18" class="digit-ring-bg" />
        <circle cx="22" cy="22" r="14" class="digit-fill" fill="none" />
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
      fill: cell.querySelector(".digit-fill"),
      text: cell.querySelector(".digit-ring-text"),
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
    const ref = cellRefs[d];
    const isActive = lastDigit === d; // cursor is currently on this digit

    if (activeContract) {
      // A digit contract is open: the ring border shows win/lose for
      // this digit, as a full solid border (not a percentage arc).
      const barColor = activeContract.winSet.has(d) ? RISE_GREEN : FALL_RED;
      ref.ringFg.setAttribute("stroke", barColor);
      ref.ringFg.setAttribute("stroke-dasharray", circumference);
      ref.ringFg.setAttribute("stroke-dashoffset", 0);

      // The interior only fills for whichever digit the cursor is on
      // right now, in that same color, bounded inside the ring.
      ref.fill.setAttribute("fill", isActive ? barColor : "none");
      ref.fill.setAttribute("fill-opacity", "0.85");
      ref.text.setAttribute("fill", isActive ? "#FFFFFF" : "#1A1D22");
    } else {
      // No open contract: back to normal last-1000-ticks frequency stats.
      const pct = (counts[d] / total) * 100;
      const dashOffset = circumference - (pct / 100) * circumference;
      const isMax = counts[d] === max && max !== min;
      const isMin = counts[d] === min && max !== min;
      const ringColor = isMax ? RISE_GREEN : isMin ? FALL_RED : "#D4A94A";

      ref.ringFg.setAttribute("stroke", ringColor);
      ref.ringFg.setAttribute("stroke-dasharray", circumference);
      ref.ringFg.setAttribute("stroke-dashoffset", dashOffset);
      ref.fill.setAttribute("fill", "none");
      ref.text.setAttribute("fill", "#1A1D22");
    }

    ref.pct.textContent = `${((counts[d] / total) * 100).toFixed(1)}%`;

    // Same DOM nodes persist across renders (not recreated), so toggling
    // this class actually animates via the CSS transition — the zoom
    // effect — instead of just snapping to its end state.
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

  // Count down a tick-duration contract off this SAME tick, so the
  // colors clear at the exact instant the cursor reaches the final
  // digit — not one tick later, waiting on a separate server message.
  if (ticksUntilExpiry !== null) {
    ticksUntilExpiry -= 1;
    if (ticksUntilExpiry <= 0) {
      activeContract = null;
      ticksUntilExpiry = null;
    }
  }

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
document.addEventListener("algotrade:reconnected", () => {
  if (digitsActive && currentDigitsSymbol) loadDigitsFor(currentDigitsSymbol, currentPipSize);
});
