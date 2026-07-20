// ==========================================================
// AlgoTrade — markets.js  (New Deriv API field names)
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

// "synthetic_index" -> "Synthetic Index", "major_pairs" -> "Major Pairs"
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
    // New API: only "brief" vs "full" is accepted — no product_type,
    // landing_company, etc. (those were rejected as "not allowed").
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
  } catch (err) {
    marketListEl.innerHTML = `<p class="market-error">Couldn't load markets: ${err.message}</p>`;
  }
}

function renderTabs() {
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

  priceStripEl.classList.remove("hidden");
  priceSymbolNameEl.textContent = displayName;
  priceSymbolCodeEl.textContent = symbol;
  priceValueEl.textContent = "…";

  // Note: unlike active_symbols, the ticks request/response still use
  // the plain "symbol" field name in the new API (not underlying_symbol).
  AppState.unsubscribeTicks = derivAPI.subscribe({ ticks: symbol }, (data) => {
    if (data.tick) {
      priceValueEl.textContent = data.tick.quote;
    }
  });

  document.dispatchEvent(new CustomEvent("algotrade:symbol-selected", { detail: { symbol, displayName } }));
}

marketSearchEl.addEventListener("input", renderList);

document.addEventListener("algotrade:account-ready", loadMarkets);
