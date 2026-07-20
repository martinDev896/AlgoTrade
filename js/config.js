// ==========================================================
// AlgoTrade — configuration (New Deriv API)
// ==========================================================

const DERIV_CONFIG = {
  // Your app's client_id / App ID from developers.deriv.com/dashboard
  CLIENT_ID: "33Rch7JPS36kkSKC2iDDt",

  // Must exactly match the redirect URL registered for this app
  REDIRECT_URI: "https://martindev896.github.io/AlgoTrade/",

  // New API OAuth2 + PKCE endpoints — do not change
  AUTH_URL: "https://auth.deriv.com/oauth2/auth",

  // Your Cloudflare Worker URL that performs the code -> token exchange.
  // Deploy cloudflare-worker/token-exchange-worker.js first, then paste
  // the resulting workers.dev URL here.
  TOKEN_EXCHANGE_URL: "https://raspy-brook-b74a.martinkimathi896.workers.dev/",

  // REST base for account management — do not change
  ACCOUNTS_API_BASE: "https://api.derivws.com/trading/v1/options",

  // Scopes requested from the user during authorization.
  // "Application insights" (app-level stats) isn't a per-user consent
  // scope, so it's left out here.
  SCOPE: "trade account_manage",
};
