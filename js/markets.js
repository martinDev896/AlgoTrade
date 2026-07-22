// ==========================================================
// AlgoTrade — markets.js
// ==========================================================

window.AppState = window.AppState || {};
window.AppState.allSymbols = [];
window.AppState.activeTab = null;
window.AppState.selectedSymbol = null;
window.AppState.unsubscribeTicks = null;

const marketTabsEl = document.getElementById("market-tabs");
const marketListEl = document.getElementById("market-list");
const marketSearchEl = document.getElementById("market-search");
const priceStripEl = document.getElementById("price-strip");
const priceSymbolNameEl = document.getElementById("price-symbol-name");
const priceSymbolCodeEl = document.getElementById("price-symbol-code");
const priceValueEl = document.getElementById("price-value");

let symbolsLoaded = false;

function titleCase(rawCode) {
  if (!rawCode) return "Other";
  return rawCode
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function loadMarkets() {
  if (symbolsLoaded) return;
  symbolsLoaded = true;

  try {
    const res = await derivAPI.send({ active_symbols: "brief" });

    AppState.allSymbols = (res.active_symbols || []).map((s) => ({
      symbol: s.underlying_symbol,
      displayName: s.underlying_symbol_name,
      marketCode: s.market,
      marketLabel: titleCase(s.market),
      submarketLabel: titleCase(s.submarket),
      exchangeIsOpen: !!s.exchange_is_open,
    }));

    renderTabs();
    renderList();

    // Auto-select first symbol so chart isn't empty when Manual Trader opens
    if (AppState.allSymbols.length > 0) {
      selectSymbol(AppState.allSymbols[0].symbol, AppState.allSymbols[0].displayName);
    }
  } catch (err) {
    if (marketListEl) {
      marketListEl.innerHTML = `<p class="market-error">Couldn't load markets: ${err.message}</p>`;
    }
  }
}

function renderTabs() {
  if (!marketTabsEl) return;
  const seen = new Set();
  const categories = [];
  AppState.allSymbols.forEach((s) => {
    if (!seen.has(s.marketLabel)) {
      seen.add(s.marketLabel);
      categories.push(s.marketLabel);
    }
  });

  AppState.activeTab = categories[0] || null;

  marketTabsEl.innerHTML = categories
    .map((cat) => `<button class="tab-btn${cat === AppState.activeTab ? " active" : ""}" data-cat="${cat}">${cat}</button>`)
    .join("");

  marketTabsEl.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      AppState.activeTab = btn.dataset.cat;
      marketTabsEl.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      if (marketSearchEl) marketSearchEl.value = "";
      renderList();
    });
  });
}

function renderList() {
  if (!marketListEl) return;
  const query = marketSearchEl ? marketSearchEl.value.trim().toLowerCase() : "";

  const filtered = AppState.allSymbols.filter((s) => {
    if (query) {
      return (
        s.displayName.toLowerCase().includes(query) ||
        s.symbol.toLowerCase().includes(query)
      );
    }
    return s.marketLabel === AppState.activeTab;
  });

  if (filtered.length === 0) {
    marketListEl.innerHTML = `<p class="market-empty">No markets match.</p>`;
    return;
  }

  marketListEl.innerHTML = filtered
    .map((s) => `
      <button class="market-item${s.symbol === AppState.selectedSymbol ? " active" : ""}" data-symbol="${s.symbol}" data-name="${s.displayName}">
        <span class="market-item-name">${s.displayName}</span>
        <span class="market-item-sub">${s.submarketLabel}</span>
        ${s.exchangeIsOpen ? '<span class="market-open-dot" title="Market open"></span>' : '<span class="market-closed-label">Closed</span>'}
      </button>
    `)
    .join("");

  marketListEl.querySelectorAll(".market-item").forEach((btn) => {
    btn.addEventListener("click", () => selectSymbol(btn.dataset.symbol, btn.dataset.name));
  });
}

function selectSymbol(symbol, displayName) {
  if (AppState.unsubscribeTicks) {
    AppState.unsubscribeTicks();
    AppState.unsubscribeTicks = null;
  }

  AppState.selectedSymbol = symbol;
  renderList();

  if (priceStripEl) priceStripEl.classList.remove("hidden");
  if (priceSymbolNameEl) priceSymbolNameEl.textContent = displayName;
  if (priceSymbolCodeEl) priceSymbolCodeEl.textContent = symbol;
  if (priceValueEl) priceValueEl.textContent = "…";

  // 1. Point iframe to Deriv's live SmartCharts app
  const chartContainer = document.getElementById("chart-container");
  const chartIframe = document.getElementById("deriv-chart-iframe");
  if (chartContainer && chartIframe) {
    chartContainer.classList.remove("hidden");
    chartIframe.src = `https://charts.deriv.com/deriv?symbol=${symbol}&theme=dark`;
  }

  // 2. Reveal trade panel & digit spotter
  const tradePanel = document.getElementById("trade-panel");
  const digitSpotter = document.getElementById("digit-spotter");
  if (tradePanel) tradePanel.classList.remove("hidden");
  if (digitSpotter) digitSpotter.classList.remove("hidden");

  // 3. Subscribe to real-time tick stream
  AppState.unsubscribeTicks = derivAPI.subscribe({ ticks: symbol }, (data) => {
    if (data.tick) {
      const rawPrice = data.tick.quote;
      if (priceValueEl) priceValueEl.textContent = rawPrice;

      // Extract last digit for Last Digit Spotter
      const priceStr = String(rawPrice);
      const lastChar = priceStr.slice(-1);
      if (!isNaN(lastChar)) {
        updateDigitSpotter(parseInt(lastChar, 10));
      }
    }
  });

  document.dispatchEvent(new CustomEvent("algotrade:symbol-selected", { detail: { symbol, displayName } }));
}

function updateDigitSpotter(digit) {
  document.querySelectorAll(".digit-cell").forEach((cell) => {
    cell.classList.remove("active-digit");
  });
  const activeCell = document.getElementById(`digit-cell-${digit}`);
  if (activeCell) {
    activeCell.classList.add("active-digit");
  }
}

if (marketSearchEl) {
  marketSearchEl.addEventListener("input", renderList);
}

document.addEventListener("algotrade:account-ready", loadMarkets);
