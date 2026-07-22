// ==========================================================
// AlgoTrade — auth.js
// ==========================================================

const connectScreen = document.getElementById("connect-screen");
const accountScreen = document.getElementById("account-screen");
const errorScreen = document.getElementById("error-screen");
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const retryBtn = document.getElementById("retry-btn");
const errorMessage = document.getElementById("error-message");
const accountList = document.getElementById("account-list");
const connectionPill = document.getElementById("connection-pill");

// Nav tab elements
const appNav = document.getElementById("app-nav");
const navAccountsBtn = document.getElementById("nav-accounts-btn");
const navManualBtn = document.getElementById("nav-manual-btn");
const accountsView = document.getElementById("accounts-view");
const manualTraderView = document.getElementById("manual-trader-view");

function showScreen(name) {
  connectScreen.classList.add("hidden");
  accountScreen.classList.add("hidden");
  errorScreen.classList.add("hidden");
  if (appNav) appNav.classList.add("hidden");

  if (name === "connect") connectScreen.classList.remove("hidden");
  if (name === "account") {
    accountScreen.classList.remove("hidden");
    if (appNav) appNav.classList.remove("hidden");
    switchTab("accounts");
  }
  if (name === "error") errorScreen.classList.remove("hidden");
}

function switchTab(tab) {
  if (tab === "accounts") {
    accountsView.classList.remove("hidden");
    manualTraderView.classList.add("hidden");
    navAccountsBtn.classList.add("active");
    navManualBtn.classList.remove("active");
  } else if (tab === "manual") {
    accountsView.classList.add("hidden");
    manualTraderView.classList.remove("hidden");
    navAccountsBtn.classList.remove("active");
    navManualBtn.classList.add("active");
  }
}

if (navAccountsBtn) navAccountsBtn.addEventListener("click", () => switchTab("accounts"));
if (navManualBtn) navManualBtn.addEventListener("click", () => switchTab("manual"));

function updatePill(connected, text) {
  connectionPill.className = `pill ${connected ? "pill-online" : "pill-offline"}`;
  connectionPill.innerHTML = `<span class="dot"></span> ${text}`;
}

function renderAccounts(tokens) {
  accountList.innerHTML = tokens
    .map((t, idx) => `
      <div class="account-card${idx === 0 ? " active" : ""}">
        <div class="acc-header">
          <span class="acc-id">${t.acct}</span>
          <span class="acc-badge">${t.acct.startsWith("VRTC") ? "Demo" : "Real"}</span>
        </div>
        <div class="acc-token-preview">Token: ${t.token.slice(0, 6)}…${t.token.slice(-4)}</div>
      </div>
    `)
    .join("");
}

async function initAuth() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const state = urlParams.get("state");

  if (code && state) {
    try {
      updatePill(false, "Exchanging code…");
      const tokens = await exchangeCodeForTokens(code, state);
      saveTokens(tokens);
      window.history.replaceState({}, document.title, window.location.pathname);
      setupAuthorizedSession(tokens);
    } catch (err) {
      showError(err.message);
    }
    return;
  }

  const savedTokens = getStoredTokens();
  if (savedTokens && savedTokens.length > 0) {
    setupAuthorizedSession(savedTokens);
  } else {
    showScreen("connect");
    updatePill(false, "Not connected");
  }
}

async function setupAuthorizedSession(tokens) {
  try {
    updatePill(false, "Connecting WS…");
    await derivAPI.connect();

    const primaryToken = tokens[0].token;
    const authRes = await derivAPI.send({ authorize: primaryToken });

    if (authRes.error) {
      throw new Error(authRes.error.message);
    }

    updatePill(true, `Connected (${authRes.authorize.loginid})`);
    showScreen("account");
    renderAccounts(tokens);

    // Broadcast event so markets load automatically
    document.dispatchEvent(new CustomEvent("algotrade:account-ready"));
  } catch (err) {
    showError(`Auth failed: ${err.message}`);
  }
}

function showError(msg) {
  errorMessage.textContent = msg;
  showScreen("error");
  updatePill(false, "Error");
}

connectBtn.addEventListener("click", redirectToDerivOAuth);

disconnectBtn.addEventListener("click", () => {
  clearStoredTokens();
  derivAPI.disconnect();
  showScreen("connect");
  updatePill(false, "Not connected");
});

retryBtn.addEventListener("click", () => {
  window.location.href = window.location.pathname;
});

window.addEventListener("DOMContentLoaded", initAuth);
