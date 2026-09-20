// AlgoTrade UI bootstrap guard.
// No credentials, tokens, OAuth URLs, or trading logic are stored here.
// It only protects the UI from a stale/partially loaded Auth.js build.
(function () {
  const required = [
    "connect-screen",
    "connect-btn",
    "retry-btn",
    "disconnect-btn",
    "error-screen",
    "error-message",
  ];

  const missing = required.filter((id) => !document.getElementById(id));
  if (missing.length) {
    console.error("AlgoTrade: missing required DOM IDs:", missing);
    return;
  }

  const connectBtn = document.getElementById("connect-btn");
  const retryBtn = document.getElementById("retry-btn");

  // Auth.js normally installs these handlers. If an older cached copy or a
  // partial script load skipped that final step, restore the same handler
  // without changing the OAuth/PKCE implementation.
  if (!window.__ALGO_TRADE_AUTH_BOUND__ && typeof window.redirectToDerivOAuth === "function") {
    connectBtn.addEventListener("click", window.redirectToDerivOAuth);
    retryBtn.addEventListener("click", window.redirectToDerivOAuth);
    console.warn("AlgoTrade: restored missing authentication click handlers.");
  }
})();
