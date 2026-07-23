// ==========================================================
// AlgoTrade — auth.js  (New Deriv API: OAuth2 Authorization Code + PKCE)
//
// Flow:
//   1. User clicks "Connect to Deriv" -> we generate a PKCE pair + state,
//      stash them in sessionStorage, and redirect to auth.deriv.com.
//   2. Deriv redirects back with ?code=...&state=...
//   3. We verify state, then POST {code, code_verifier} to our Cloudflare
//      Worker, which exchanges it for an access_token (this step can't
//      happen directly from the browser — Deriv requires it server-side).
//   4. With the access_token, GET /accounts lists the user's account(s).
//   5. Picking an account calls POST /accounts/{id}/otp to get a
//      ready-to-use WebSocket URL, which api.js connects to directly.
//
// The active account's balance now lives in the navbar (top-right),
// with a dropdown to switch between accounts — not a card grid.
// ==========================================================

const TOKEN_KEY = "deriv_access_token";
const PKCE_KEY = "deriv_pkce";

window.AppState = {
  accounts: [],          // [{account_id, balance, currency, account_type}, ...]
  activeAccountId: null,
  accessToken: null,
  unsubscribeBalance: null,
};

// ---------- DOM references ----------
const connectScreen    = document.getElementById("connect-screen");
const accountScreen    = document.getElementById("account-screen");
const errorScreen      = document.getElementById("error-screen");
const errorMessageEl   = document.getElementById("error-message");
const connectBtn       = document.getElementById("connect-btn");
const disconnectBtn    = document.getElementById("disconnect-btn");
const retryBtn         = document.getElementById("retry-btn");
const connectionPill   = document.getElementById("connection-pill");
const appIdDisplay     = document.getElementById("app-id-display");
const appTabsNav       = document.getElementById("app-tabs");
const balanceWidgetEl  = document.getElementById("balance-widget");
const accountSwitcherEl = document.getElementById("account-switcher");
const balanceAmountEl  = document.getElementById("balance-amount");

appIdDisplay.textContent = DERIV_CONFIG.CLIENT_ID;

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

function setAppLightMode(on) {
  document.body.classList.toggle("app-light-mode", on);
}

// ==========================================================
// Step 1 — Redirect to Deriv with PKCE params
// ==========================================================
async function redirectToDerivOAuth() {
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const state = generateRandomString(24);

  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ codeVerifier, state }));

  const url = new URL(DERIV_CONFIG.AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", DERIV_CONFIG.CLIENT_ID);
  url.searchParams.set("redirect_uri", DERIV_CONFIG.REDIRECT_URI);
  url.searchParams.set("scope", DERIV_CONFIG.SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  window.location.href = url.toString();
}

// ==========================================================
// Step 2 — Handle the redirect back (?code=...&state=...)
// ==========================================================
function parseCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return { code: params.get("code"), state: params.get("state") };
}

function stripAuthParamsFromUrl() {
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);
}

// ==========================================================
// Step 3 — Exchange the code for a token via our Cloudflare Worker
// ==========================================================
async function exchangeCodeForToken(code, codeVerifier) {
  const res = await fetch(DERIV_CONFIG.TOKEN_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || "Token exchange failed.");
  }
  return data.access_token;
}

// ==========================================================
// Step 4 — List accounts
// ==========================================================
async function fetchAccounts(accessToken) {
  const res = await fetch(`${DERIV_CONFIG.ACCOUNTS_API_BASE}/accounts`, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Deriv-App-ID": DERIV_CONFIG.CLIENT_ID,
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.errors?.[0]?.message || "Could not load accounts.");
  }
  return body.data;
}

// ==========================================================
// Step 5 — Populate the account switcher + activate one via OTP
// ==========================================================
function renderAccountSwitcher(accounts) {
  accountSwitcherEl.innerHTML = accounts
    .map((acct) => {
      const label = `${acct.account_type === "demo" ? "Demo" : "Real"} · ${acct.account_id}`;
      return `<option value="${acct.account_id}">${label}</option>`;
    })
    .join("");
}

function updateBalanceDisplay(amount, currency) {
  balanceAmountEl.textContent =
    `${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${currency}`;
}

async function activateAccount(accountId) {
  try {
    const res = await fetch(
      `${DERIV_CONFIG.ACCOUNTS_API_BASE}/accounts/${accountId}/otp`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${AppState.accessToken}`,
          "Deriv-App-ID": DERIV_CONFIG.CLIENT_ID,
        },
      }
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.errors?.[0]?.message || "Could not start session for this account.");

    const wsUrl = body.data.url;

    if (AppState.unsubscribeBalance) AppState.unsubscribeBalance();

    await derivAPI.connectToUrl(wsUrl);

    AppState.activeAccountId = accountId;
    accountSwitcherEl.value = accountId;
    setConnectionPill(true);
    balanceWidgetEl.classList.remove("hidden");

    // Show a snapshot immediately from the accounts list while we wait
    // for the first live balance push.
    const snapshot = AppState.accounts.find((a) => a.account_id === accountId);
    if (snapshot) updateBalanceDisplay(snapshot.balance, snapshot.currency);

    AppState.unsubscribeBalance = derivAPI.subscribe({ balance: 1 }, (data) => {
      if (!data.balance) return;
      updateBalanceDisplay(data.balance.balance, data.balance.currency);
    });

    document.dispatchEvent(new CustomEvent("algotrade:account-ready", { detail: { accountId } }));
  } catch (err) {
    showError(err.message || "Could not activate this account.");
  }
}

accountSwitcherEl.addEventListener("change", () => {
  activateAccount(accountSwitcherEl.value);
});

// ==========================================================
// Orchestration
// ==========================================================
async function handleAuthCallback(code, state) {
  const stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "{}");
  stripAuthParamsFromUrl();

  if (!stored.state || state !== stored.state) {
    showError("Security check failed (state mismatch). Please try connecting again.");
    return;
  }

  try {
    const accessToken = await exchangeCodeForToken(code, stored.codeVerifier);
    sessionStorage.setItem(TOKEN_KEY, accessToken);
    sessionStorage.removeItem(PKCE_KEY);
    await loadAccounts(accessToken);
  } catch (err) {
    showError(err.message || "Could not complete sign-in with Deriv.");
  }
}

async function loadAccounts(accessToken) {
  try {
    AppState.accessToken = accessToken;
    const accounts = await fetchAccounts(accessToken);
    AppState.accounts = accounts;
    renderAccountSwitcher(accounts);

    setAppLightMode(true);
    appTabsNav.classList.remove("hidden");
    showScreen("account");

    const defaultAcct = accounts.find((a) => a.account_type !== "demo") || accounts[0];
    if (defaultAcct) await activateAccount(defaultAcct.account_id);
  } catch (err) {
    showError(err.message || "Could not load your Deriv accounts.");
  }
}

function init() {
  const { code, state } = parseCodeFromUrl();

  if (code) {
    handleAuthCallback(code, state);
    return;
  }

  const savedToken = sessionStorage.getItem(TOKEN_KEY);
  if (savedToken) {
    loadAccounts(savedToken);
    return;
  }

  showScreen("connect");
  setConnectionPill(false);
}

// ---------- Event listeners ----------
connectBtn.addEventListener("click", redirectToDerivOAuth);
retryBtn.addEventListener("click", redirectToDerivOAuth);

disconnectBtn.addEventListener("click", () => {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (AppState.unsubscribeBalance) AppState.unsubscribeBalance();
  derivAPI.close();
  AppState.accounts = [];
  AppState.activeAccountId = null;
  AppState.accessToken = null;
  setAppLightMode(false);
  appTabsNav.classList.add("hidden");
  balanceWidgetEl.classList.add("hidden");
  setConnectionPill(false);
  showScreen("connect");
});

init();
