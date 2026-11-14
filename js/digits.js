// ==========================================================
// AlgoTrade — digits.js
// Shows the last-digit distribution over the last 1,000 ticks (or fewer —
// a dropdown narrows it to 500 / 250 / 100 / 50 / 25 for live analysis) for
// synthetic index markets (where Digits contracts — Matches/Differs,
// Over/Under — actually apply). Each digit 0-9 gets a circular
// percentage ring, and a small cursor sits under whichever digit the
// most recent tick ended in. Updates live as new ticks arrive.
// ==========================================================

const digitsWidgetEl = document.getElementById("digits-widget");
const digitsRowEl = document.getElementById("digits-row");
const digitsWindowEl = document.getElementById("digits-window");
const digitsLabelEl = document.getElementById("digits-label");

// How many of the most recent ticks the percentages are calculated from.
// The full 1,000 are always kept in memory; this only changes what is counted.
const DIGIT_WINDOW_CHOICES = [1000, 500, 250, 100, 50, 25];
const DIGIT_WINDOW_KEY = "algotrade.digitWindow";
let digitWindow = (function () {
  try {
    const saved = Number(localStorage.getItem(DIGIT_WINDOW_KEY));
    return DIGIT_WINDOW_CHOICES.indexOf(saved) !== -1 ? saved : 1000;
  } catch (_) { return 1000; }
})();

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

// The slice of history the percentages are based on (the newest `digitWindow` ticks).
function digitsInWindow() {
  return digitHistory.length > digitWindow ? digitHistory.slice(-digitWindow) : digitHistory;
}

function computeCounts() {
  const counts = new Array(10).fill(0);
  digitsInWindow().forEach((d) => counts[d]++);
  return counts;
}

function updateDigitsLabel() {
  if (digitsLabelEl) {
    // The "— last N ticks" part is its own span so phones can hide it (the dropdown already shows N).
    digitsLabelEl.textContent = "Last digit distribution";
    const suffix = document.createElement("span");
    suffix.className = "digits-label-suffix";
    suffix.textContent = " — last " + digitWindow.toLocaleString("en-US") + " ticks";
    digitsLabelEl.appendChild(suffix);
  }
  if (digitsWindowEl) digitsWindowEl.value = String(digitWindow);
}

let cellRefs = []; // persistent references to each digit's DOM pieces

// The currently open digit contract, if any — drives win/lose coloring.
// { contractType, barrier, winSet: Set<number> } | null
let activeContract = null;

const RISE_GREEN = "#2ECC8F";
const FALL_RED = "#FF5C5C";
// Frequency view ring colours: most = green, 2nd most = blue, 2nd least = yellow, least = red, in between = grey.
const RING_SECOND_MOST = "#4DA3FF";
const RING_SECOND_LEAST = "#F4C430";
const RING_MIDDLE = "#BFC5CE";

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

  const total = digitsInWindow().length || 1;
  const counts = computeCounts();
  // Rank the digits by their share of the window (highest count first). Digits that tie share a colour.
  const ranks = Array.from(new Set(counts)).sort((a, b) => b - a);
  const mostCount = ranks[0], leastCount = ranks[ranks.length - 1];
  const secondMostCount = ranks.length > 1 ? ranks[1] : null;
  const secondLeastCount = ranks.length > 1 ? ranks[ranks.length - 2] : null;
  const ringColorFor = (c) => {
    if (ranks.length < 2) return RING_MIDDLE;         // nothing to tell apart (equal shares, or no ticks yet)
    if (c === mostCount) return RISE_GREEN;           // most frequent
    if (c === leastCount) return FALL_RED;            // least frequent
    if (c === secondMostCount) return RING_SECOND_MOST;     // second most frequent
    if (c === secondLeastCount) return RING_SECOND_LEAST;   // second least frequent
    return RING_MIDDLE;                               // everything in between
  };
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
      // No open contract: back to normal frequency stats over the selected number of ticks.
      const pct = (counts[d] / total) * 100;
      const dashOffset = circumference - (pct / 100) * circumference;
      const ringColor = ringColorFor(counts[d]);
      const filled = ringColor === RISE_GREEN || ringColor === FALL_RED;
      // Most / least frequent digits (green / red) also get a matching fill inside the ring. The digit stays dark (#1A1D22, set by CSS): about 8.7:1 contrast on the green fill and 6.1:1 on the red (white would be only 1.9:1 and 2.8:1).

      ref.ringFg.setAttribute("stroke", ringColor);
      ref.ringFg.setAttribute("stroke-dasharray", circumference);
      ref.ringFg.setAttribute("stroke-dashoffset", dashOffset);
      ref.fill.setAttribute("fill", filled ? ringColor : "none");
      ref.fill.setAttribute("fill-opacity", "0.9");
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

  // Count down a tick-duration contract off this SAME tick. The final
  // tick still renders WITH its win/lose color (that's the contract's
  // last live moment) — only the tick AFTER it should render clear, so
  // the contract is cleared after this render, not before it.
  let justExpired = false;
  if (ticksUntilExpiry !== null) {
    ticksUntilExpiry -= 1;
    if (ticksUntilExpiry <= 0) justExpired = true;
  }

  renderDigits();

  if (justExpired) {
    activeContract = null;
    ticksUntilExpiry = null;
  }
});

// The widget needs BOTH a synthetic symbol selected AND the Digits trade
// type active — Rise/Fall and Accumulators don't use it at all.
let currentTradeGroup = "rise_fall";
let lastSelectedSymbolMeta = null;

function updateDigitsVisibility(symbol, displayNameUnused) {
  const meta = lastSelectedSymbolMeta;
  const isSynthetic = meta && meta.marketCode === "synthetic_index";
  const shouldShow = isSynthetic && currentTradeGroup === "digits";

  digitsActive = shouldShow;
  digitsWidgetEl.classList.toggle("hidden", !shouldShow);

  if (shouldShow && symbol !== currentDigitsSymbol) {
    loadDigitsFor(symbol, meta.pipSize);
  } else if (!shouldShow) {
    currentDigitsSymbol = null;
  }
}

document.addEventListener("algotrade:symbol-selected", (e) => {
  lastSelectedSymbolMeta = AppState.allSymbols.find((s) => s.symbol === e.detail.symbol);
  updateDigitsVisibility(e.detail.symbol);
});

document.addEventListener("algotrade:trade-group-changed", (e) => {
  currentTradeGroup = e.detail.group;
  if (AppState.selectedSymbol) updateDigitsVisibility(AppState.selectedSymbol);
});
document.addEventListener("algotrade:reconnected", () => {
  if (digitsActive && currentDigitsSymbol) loadDigitsFor(currentDigitsSymbol, currentPipSize);
});

// ---- Tick-window dropdown (shared with the Sniper Trader widget) ----
function setDigitWindow(n, announce) {
  if (DIGIT_WINDOW_CHOICES.indexOf(n) === -1 || n === digitWindow) { updateDigitsLabel(); return; }
  digitWindow = n;
  try { localStorage.setItem(DIGIT_WINDOW_KEY, String(n)); } catch (_) { /* private mode: setting just isn't remembered */ }
  updateDigitsLabel();
  renderDigits();
  if (announce) document.dispatchEvent(new CustomEvent("algotrade:digit-window-changed", { detail: { count: n } }));
}

if (digitsWindowEl) {
  digitsWindowEl.addEventListener("change", () => setDigitWindow(Number(digitsWindowEl.value), true));
}
document.addEventListener("algotrade:digit-window-changed", (e) => setDigitWindow(e.detail.count, false));
updateDigitsLabel();
