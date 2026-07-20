// ==========================================================
// AlgoTrade — configuration
// Values from the Deriv API dashboard
// (https://developers.deriv.com/dashboard)
// ==========================================================

const DERIV_CONFIG = {
  APP_ID: "33Rch7JPS36kkSKC2iDDt",

  // Must exactly match the redirect URI registered for this App ID.
  REDIRECT_URI: "https://martindev896.github.io/AlgoTrade/",

  // Deriv's OAuth authorize endpoint — do not change
  OAUTH_URL: "https://oauth.deriv.com/oauth2/authorize",

  // Deriv's WebSocket endpoint — do not change
  WS_URL: "wss://ws.derivws.com/websockets/v3",
};
