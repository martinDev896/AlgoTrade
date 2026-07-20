// ==========================================================
// AlgoTrade — auth.js
// Phase 1: Connect / Authorize flow only.
//
// Flow:
//   1. User clicks "Connect to Deriv" -> redirected to Deriv's OAuth page.
//   2. Deriv redirects back to REDIRECT_URI with ?acct1=...&token1=...&cur1=...
//      (repeated as acct2/token2/cur2, etc. if the user has multiple accounts).
//   3. We parse those params, store them for the session, and open a
//      WebSocket per account to call "authorize" and fetch balance/details.
//   4. Accounts are rendered as cards. "Disconnect" clears everything.
//
// Nothing here places trades yet — that's a later phase, built on top of
// the authorized tokens saved in sessionStorage.
// ==========================================================

const STORAGE_KEY = "deriv_accounts";

// Shared app state other scripts (markets.js, trade.js) read from.
window.AppState = {
  accounts: [],          // [{loginid, fullname, currency, balance, is_virtual, scopes}, ...]
  activeLoginid: null,   // which account is authorized on the persistent connection
  unsubscribeBalance: null,
};

// ---------- DOM references ----------
const connectScreen   = document.getElementById("connect-screen");
const accountScreen   = document.getElementById("account-screen");
const errorScreen     = document.getElementById("error-screen");
const errorMessageEl  = document.getElementById("error-message");
const connectBtn      = document.getElementById("connect-btn");
const disconnectBtn   = document.getElementById("disconnect-btn");
const retryBtn        = document.getElementById("retry-btn");
const accountListEl   = document.getElementById("account-list");
const connectionPill  = document.getElementById("connection-pill");
const appIdDisplay    = document.getElementById("app-id-display");

appIdDisplay.textContent = DERIV_CONFIG.APP_ID;

// ---------- Screen helpers ----------
function showScreen(name) {
  connectScreen.classList.add("hidden");
  accountScreen.classList.add("hidden");
  errorScreen.classList.add("hidden");

  if (name === "connect") connectScreen.classList.remove("hidden");
  if (name === "account") accountScreen.classList.remove("hidden");
  if (name === "error") errorScreen.classList.remove("hidden");
}

function setConnectionPill(connected) {
  connectionPill.classList.toggle("pill-online", connected);
  connectionPill.classList.toggle("pill-offline", !connected);
  connectionPill.innerHTML = connected
    ? `<span class="dot"></span> Connected`
    : `<span class="dot"></span> Not connected`;
}

function showError(message) {
  errorMessageEl.textContent = message;
  showScreen("error");
}

// ==========================================================
// Step 1 — Build the OAuth URL and redirect the user to Deriv
// ==========================================================
function redirectToDerivOAuth() {
  const url = new URL(DERIV_CONFIG.OAUTH_URL);
  url.searchParams.set("app_id", DERIV_CONFIG.APP_ID);
  // Deriv sends the user back to whatever redirect URI is registered
  // for this app_id — REDIRECT_URI here is just for our own reference.
  window.location.href = url.toString();
}

// ==========================================================
// Step 2 — Parse acctN / tokenN / curN params from the redirect
// ==========================================================
function parseAccountsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const accounts = [];
  let i = 1;

  while (params.has(`acct${i}`)) {
    accounts.push({
      loginid: params.get(`acct${i}`),
      token: params.get(`token${i}`),
      currency: params.get(`cur${i}`),
    });
    i++;
  }
  return accounts;
}

function stripAuthParamsFromUrl() {
  // Clean the tokens out of the address bar so they aren't left visible
  // in browser history / bookmarks.
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);
}

// ==========================================================
// Step 3 — Authorize each account over the Deriv WebSocket API
// ==========================================================
function authorizeAccount(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${DERIV_CONFIG.WS_URL}?app_id=${DERIV_CONFIG.APP_ID}`);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for Deriv to respond."));
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ authorize: token }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(data.error.message));
        return;
      }

      if (data.msg_type === "authorize") {
        clearTimeout(timeout);
        const info = data.authorize;
        ws.close(); // Phase 1 only needs the snapshot; later phases will
                    // keep a persistent connection open for live data/trading.
        resolve({
          loginid: info.loginid,
          fullname: info.fullname,
          currency: info.currency,
          balance: info.balance,
          is_virtual: info.is_virtual,
          scopes: info.scopes,
        });
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Could not reach Deriv's server. Check your connection."));
    };
  });
}

// ==========================================================
// Step 4 — Render authorized accounts as cards
// ==========================================================
function renderAccounts(accounts) {
  accountListEl.innerHTML = "";

  accounts.forEach((acct) => {
    const card = document.createElement("div");
    card.className = "account-card";
    card.dataset.loginid = acct.loginid;

    const typeClass = acct.is_virtual ? "demo" : "real";
    const typeLabel = acct.is_virtual ? "Demo" : "Real";

    card.innerHTML = `
      <div class="acct-card-top">
        <div>
          <span class="acct-id">${acct.loginid}</span>
          <span class="acct-type ${typeClass}">${typeLabel}</span>
        </div>
        <button class="btn-select" data-loginid="${acct.loginid}">Use this account</button>
      </div>
      <div class="acct-balance" id="balance-${acct.loginid}">
        ${Number(acct.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
        <span class="acct-currency">${acct.currency}</span>
      </div>
    `;
    accountListEl.appendChild(card);
  });

  accountListEl.querySelectorAll(".btn-select").forEach((btn) => {
    btn.addEventListener("click", () => activateAccount(btn.dataset.loginid));
  });
}

function markActiveCard(loginid) {
  accountListEl.querySelectorAll(".account-card").forEach((card) => {
    const isActive = card.dataset.loginid === loginid;
    card.classList.toggle("active", isActive);
    const btn = card.querySelector(".btn-select");
    btn.textContent = isActive ? "Active" : "Use this account";
    btn.disabled = isActive;
  });
}

/**
 * Authorize the persistent connection (used for live balance, markets,
 * charts and trading) against the chosen account, and subscribe to its
 * live balance stream.
 */
async function activateAccount(loginid) {
  const acct = AppState.accounts.find((a) => a.loginid === loginid);
  if (!acct) return;

  try {
    await derivAPI.connect();
    await derivAPI.authorize(acct.token);

    if (AppState.unsubscribeBalance) {
      AppState.unsubscribeBalance();
    }

    AppState.activeLoginid = loginid;
    markActiveCard(loginid);

    AppState.unsubscribeBalance = derivAPI.subscribe(
      { balance: 1 },
      (data) => {
        if (!data.balance) return;
        const el = document.getElementById(`balance-${loginid}`);
        if (el) {
          el.innerHTML = `
            ${Number(data.balance.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            <span class="acct-currency">${data.balance.currency}</span>
          `;
        }
      }
    );

    // Let markets.js / trade.js know they can now use the connection.
    document.dispatchEvent(new CustomEvent("algotrade:account-ready", { detail: { loginid } }));
  } catch (err) {
    showError(err.message || "Could not activate this account.");
  }
}

// ==========================================================
// Step 5 — Orchestration: figure out what state we're in on load
// ==========================================================
async function loadAndAuthorizeAccounts(accounts) {
  try {
    const authorized = await Promise.all(
      accounts.map(async (a) => ({ ...(await authorizeAccount(a.token)), token: a.token }))
    );
    AppState.accounts = authorized;
    renderAccounts(authorized);
    setConnectionPill(true);
    showScreen("account");

    // Default to the first real account, falling back to the first demo account.
    const defaultAcct = authorized.find((a) => !a.is_virtual) || authorized[0];
    if (defaultAcct) await activateAccount(defaultAcct.loginid);
  } catch (err) {
    setConnectionPill(false);
    showError(err.message || "Authorization failed. Please reconnect.");
  }
}

function init() {
  const urlAccounts = parseAccountsFromUrl();

  if (urlAccounts.length > 0) {
    // Just came back from Deriv's OAuth page
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(urlAccounts));
    stripAuthParamsFromUrl();
    loadAndAuthorizeAccounts(urlAccounts);
    return;
  }

  const saved = sessionStorage.getItem(STORAGE_KEY);
  if (saved) {
    // Returning within the same session — re-authorize to get fresh balances
    loadAndAuthorizeAccounts(JSON.parse(saved));
    return;
  }

  // No session yet
  showScreen("connect");
  setConnectionPill(false);
}

// ---------- Event listeners ----------
connectBtn.addEventListener("click", redirectToDerivOAuth);
retryBtn.addEventListener("click", redirectToDerivOAuth);

disconnectBtn.addEventListener("click", () => {
  sessionStorage.removeItem(STORAGE_KEY);
  if (AppState.unsubscribeBalance) AppState.unsubscribeBalance();
  AppState.accounts = [];
  AppState.activeLoginid = null;
  setConnectionPill(false);
  showScreen("connect");
});

init();
