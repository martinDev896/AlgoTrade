// ==========================================================
// AlgoTrade — Markets
// Full-width chart market selector. The selector is floating over
// the chart so the chart keeps the space previously occupied by
// the permanent market sidebar.
// ==========================================================

window.AppState.allSymbols = [];
window.AppState.activeTab = null;
window.AppState.selectedSymbol = null;
window.AppState.selectedDisplayName = null;
window.AppState.unsubscribeTicks = null;

const marketSelectorEl = document.getElementById("market-selector");
const marketSelectorBtnEl = document.getElementById("market-selector-btn");
const marketDropdownEl = document.getElementById("market-dropdown");
const marketTabsEl = document.getElementById("market-tabs");
const marketListEl = document.getElementById("market-list");
const marketSearchEl = document.getElementById("market-search");
const priceSymbolNameEl = document.getElementById("price-symbol-name");
const priceSymbolCodeEl = document.getElementById("price-symbol-code");
const priceValueEl = document.getElementById("price-value");
const marketCountEl = document.getElementById("market-count");

const DEFAULT_SYMBOL = "1HZ100V";
const DEFAULT_DISPLAY_NAME = "Volatility 100 (1s)";
let symbolsLoaded = false;

function titleCase(rawCode) {
  if (!rawCode) return "Other";
  return rawCode.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function setMarketDropdown(open) {
  marketDropdownEl.classList.toggle("hidden", !open);
  marketSelectorBtnEl.setAttribute("aria-expanded", String(open));
}

marketSelectorBtnEl.addEventListener("click", (event) => {
  event.stopPropagation();
  setMarketDropdown(marketDropdownEl.classList.contains("hidden"));
  if (!marketDropdownEl.classList.contains("hidden")) marketSearchEl.focus();
});

marketDropdownEl.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => setMarketDropdown(false));

function renderTabs() {
  const seen = new Set();
  const categories = [];
  AppState.allSymbols.forEach((s) => {
    if (!seen.has(s.marketLabel)) {
      seen.add(s.marketLabel);
      categories.push(s.marketLabel);
    }
  });

  AppState.activeTab = AppState.activeTab && categories.includes(AppState.activeTab)
    ? AppState.activeTab
    : categories[0] || null;

  marketTabsEl.innerHTML = ["All", ...categories]
    .map((cat) => `<button class="tab-btn${cat === (AppState.activeTab || "All") ? " active" : ""}" data-cat="${cat}">${cat}</button>`)
    .join("");

  marketTabsEl.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      AppState.activeTab = btn.dataset.cat;
      marketTabsEl.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderList();
    });
  });
}

function renderList() {
  const query = marketSearchEl.value.trim().toLowerCase();
  const active = AppState.activeTab || "All";

  const filtered = AppState.allSymbols.filter((s) => {
    const matchesQuery = !query || s.displayName.toLowerCase().includes(query) || s.symbol.toLowerCase().includes(query);
    const matchesCategory = active === "All" || s.marketLabel === active;
    return matchesQuery && matchesCategory;
  });

  marketCountEl.textContent = `${filtered.length} markets`;

  if (!filtered.length) {
    marketListEl.innerHTML = `<p class="market-empty">No markets match.</p>`;
    return;
  }

  marketListEl.innerHTML = filtered.map((s) => `
    <button class="market-item${s.symbol === AppState.selectedSymbol ? " active" : ""}" data-symbol="${s.symbol}" data-name="${s.displayName}">
      <span class="market-item-name">${s.displayName}</span>
      <span class="market-item-sub">${s.submarketLabel}</span>
      ${s.exchangeIsOpen ? '<span class="market-open-dot" title="Market open"></span>' : '<span class="market-closed-label">Closed</span>'}
    </button>
  `).join("");

  marketListEl.querySelectorAll(".market-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectSymbol(btn.dataset.symbol, btn.dataset.name);
      setMarketDropdown(false);
    });
  });
}

function selectSymbol(symbol, displayName) {
  if (!symbol) return;

  if (AppState.unsubscribeTicks) {
    AppState.unsubscribeTicks();
    AppState.unsubscribeTicks = null;
  }

  AppState.selectedSymbol = symbol;
  AppState.selectedDisplayName = displayName || symbol;
  priceSymbolNameEl.textContent = AppState.selectedDisplayName;
  priceSymbolCodeEl.textContent = symbol;
  priceValueEl.textContent = "…";
  document.getElementById("trade-market-mini").textContent = symbol;

  renderList();

  AppState.unsubscribeTicks = derivAPI.subscribe({ ticks: symbol }, (data) => {
    if (data.tick) priceValueEl.textContent = data.tick.quote;
  });

  document.dispatchEvent(new CustomEvent("algotrade:symbol-selected", {
    detail: { symbol, displayName: AppState.selectedDisplayName },
  }));
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
      pipSize: s.pip_size,
    }));

    renderTabs();
    renderList();

    const defaultMarket = AppState.allSymbols.find((s) => s.symbol === DEFAULT_SYMBOL);
    if (defaultMarket) {
      selectSymbol(defaultMarket.symbol, defaultMarket.displayName || DEFAULT_DISPLAY_NAME);
    } else if (AppState.allSymbols.length) {
      selectSymbol(AppState.allSymbols[0].symbol, AppState.allSymbols[0].displayName);
    }
  } catch (err) {
    marketListEl.innerHTML = `<p class="market-error">Couldn't load markets: ${err.message}</p>`;
  }
}

marketSearchEl.addEventListener("input", renderList);
document.addEventListener("algotrade:account-ready", loadMarkets);
