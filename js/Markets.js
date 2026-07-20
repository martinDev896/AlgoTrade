// ==========================================================
// AlgoTrade — markets.js
// Once the persistent connection is authorized (see auth.js), this:
//   1. Fetches every tradable symbol across all Deriv markets
//   2. Groups them into category tabs (Forex, Synthetic Indices, etc.)
//   3. Renders a searchable list
//   4. Streams a live spot price for whatever symbol is selected
//
// AppState.selectedSymbol / AppState.unsubscribeTicks are shared so
// the upcoming chart + trade panel can build on the same selection.
// ==========================================================

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

async function loadMarkets() {
  if (symbolsLoaded) return;
  symbolsLoaded = true;

  try {
    const res = await derivAPI.send({ active_symbols: "brief", product_type: "basic" });
    AppState.allSymbols = res.active_symbols || [];
    renderTabs();
    renderList();
  } catch (err) {
    marketListEl.innerHTML = `<p class="market-error">Couldn't load markets: ${err.message}</p>`;
  }
}

function renderTabs() {
  // Preserve Deriv's own ordering, just de-duplicated.
  const seen = new Set();
  const categories = [];
  AppState.allSymbols.forEach((s) => {
    if (!seen.has(s.market_display_name)) {
      seen.add(s.market_display_name);
      categories.push(s.market_display_name);
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
      marketSearchEl.value = "";
      renderList();
    });
  });
}

function renderList() {
  const query = marketSearchEl.value.trim().toLowerCase();

  const filtered = AppState.allSymbols.filter((s) => {
    if (query) {
      return (
        s.display_name.toLowerCase().includes(query) ||
        s.symbol.toLowerCase().includes(query)
      );
    }
    return s.market_display_name === AppState.activeTab;
  });

  if (filtered.length === 0) {
    marketListEl.innerHTML = `<p class="market-empty">No markets match.</p>`;
    return;
  }

  marketListEl.innerHTML = filtered
    .map((s) => `
      <button class="market-item${s.symbol === AppState.selectedSymbol ? " active" : ""}" data-symbol="${s.symbol}" data-name="${s.display_name}">
        <span class="market-item-name">${s.display_name}</span>
        <span class="market-item-sub">${s.submarket_display_name}</span>
        ${s.exchange_is_open ? '<span class="market-open-dot" title="Market open"></span>' : '<span class="market-closed-label">Closed</span>'}
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
  renderList(); // refresh highlighted state

  priceStripEl.classList.remove("hidden");
  priceSymbolNameEl.textContent = displayName;
  priceSymbolCodeEl.textContent = symbol;
  priceValueEl.textContent = "…";

  AppState.unsubscribeTicks = derivAPI.subscribe({ ticks: symbol }, (data) => {
    if (data.tick) {
      priceValueEl.textContent = data.tick.quote;
    }
  });

  // Other scripts (chart.js / trade.js, coming next) can listen for this.
  document.dispatchEvent(new CustomEvent("algotrade:symbol-selected", { detail: { symbol, displayName } }));
}

marketSearchEl.addEventListener("input", renderList);

document.addEventListener("algotrade:account-ready", loadMarkets);
