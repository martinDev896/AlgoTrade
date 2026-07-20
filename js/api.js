// ==========================================================
// AlgoTrade — api.js
// A single persistent WebSocket connection to Deriv, shared by the
// whole app. Everything else (balance, markets, charts, trading)
// talks to Deriv through this one connection instead of opening
// its own sockets.
//
// Usage:
//   await derivAPI.connect();
//   const authInfo = await derivAPI.authorize(token);
//   const unsub = derivAPI.subscribe({ balance: 1, subscribe: 1 }, (data) => {...});
//   const response = await derivAPI.send({ active_symbols: "brief" });
// ==========================================================

class DerivConnection {
  constructor(appId, wsUrl) {
    this.appId = appId;
    this.wsUrl = wsUrl;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();       // req_id -> {resolve, reject}
    this.subscriptions = new Map(); // req_id -> callback (for streamed data)
    this.connectPromise = null;
    this.currentToken = null;       // so we can re-authorize after a reconnect
    this.onStatusChange = null;     // optional external hook, e.g. update the UI pill
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.wsUrl}?app_id=${this.appId}`);

      this.ws.onopen = () => {
        if (this.onStatusChange) this.onStatusChange("connected");
        resolve();
      };

      this.ws.onmessage = (event) => this._handleMessage(event);

      this.ws.onerror = (err) => {
        if (this.onStatusChange) this.onStatusChange("error");
        reject(err);
      };

      this.ws.onclose = () => {
        if (this.onStatusChange) this.onStatusChange("disconnected");
        this.connectPromise = null;
        // Simple auto-reconnect. Trade/chart code re-subscribes itself
        // by listening for "reconnected" and re-issuing subscriptions.
        setTimeout(() => this._reconnect(), 2000);
      };
    });

    return this.connectPromise;
  }

  async _reconnect() {
    await this.connect();
    if (this.currentToken) {
      await this.authorize(this.currentToken);
    }
    if (this.onStatusChange) this.onStatusChange("reconnected");
  }

  _handleMessage(event) {
    const data = JSON.parse(event.data);

    if (data.req_id !== undefined) {
      // Streamed/subscribed data keeps arriving under the same req_id
      if (this.subscriptions.has(data.req_id)) {
        this.subscriptions.get(data.req_id)(data);
        // Also resolve the one-time pending promise the first time it arrives
        if (this.pending.has(data.req_id)) {
          const { resolve, reject } = this.pending.get(data.req_id);
          this.pending.delete(data.req_id);
          data.error ? reject(new Error(data.error.message)) : resolve(data);
        }
        return;
      }

      if (this.pending.has(data.req_id)) {
        const { resolve, reject } = this.pending.get(data.req_id);
        this.pending.delete(data.req_id);
        data.error ? reject(new Error(data.error.message)) : resolve(data);
      }
    }
  }

  /** Send a one-off request, resolves with the full response. */
  send(request) {
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqId;
      this.pending.set(reqId, { resolve, reject });
      this.ws.send(JSON.stringify({ ...request, req_id: reqId }));
    });
  }

  /**
   * Send a subscription request. `onUpdate` fires for every push
   * (including the first). Returns an unsubscribe() function.
   */
  subscribe(request, onUpdate) {
    const reqId = ++this.reqId;
    this.subscriptions.set(reqId, onUpdate);
    this.pending.set(reqId, { resolve: () => {}, reject: () => {} });
    this.ws.send(JSON.stringify({ ...request, subscribe: 1, req_id: reqId }));

    return async () => {
      this.subscriptions.delete(reqId);
      try {
        await this.send({ forget_all: request.balance ? "balance" : "ticks" });
      } catch (_) { /* best effort */ }
    };
  }

  async authorize(token) {
    this.currentToken = token;
    const res = await this.send({ authorize: token });
    return res.authorize;
  }
}

const derivAPI = new DerivConnection(DERIV_CONFIG.APP_ID, DERIV_CONFIG.WS_URL);
