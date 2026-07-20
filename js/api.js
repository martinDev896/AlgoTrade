// ==========================================================
// AlgoTrade — api.js
// A single persistent WebSocket connection to Deriv, shared by the
// whole app. Connects using the OTP-embedded URL obtained from the
// REST accounts/otp endpoint (see auth.js) — the OTP already
// authenticates the connection, so there's no separate "authorize"
// step like the old API required.
//
// Usage:
//   await derivAPI.connectToUrl(otpWsUrl);
//   const unsub = derivAPI.subscribe({ balance: 1 }, (data) => {...});
//   const response = await derivAPI.send({ active_symbols: "brief" });
// ==========================================================

class DerivConnection {
  constructor() {
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();       // req_id -> {resolve, reject}
    this.subscriptions = new Map(); // req_id -> callback (for streamed data)
    this.connectPromise = null;
    this.currentUrl = null;         // so we can reconnect to the same OTP URL
    this.onStatusChange = null;     // optional external hook, e.g. update the UI pill
  }

  connectToUrl(wsUrl) {
    this.currentUrl = wsUrl;
    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

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
        // NOTE: OTPs are short-lived and single-use, so a naive reconnect
        // to the same URL will likely fail once it closes. When we build
        // the trade panel we'll wire this to request a fresh OTP instead.
      };
    });

    return this.connectPromise;
  }

  _handleMessage(event) {
    const data = JSON.parse(event.data);

    if (data.req_id !== undefined) {
      if (this.subscriptions.has(data.req_id)) {
        this.subscriptions.get(data.req_id)(data);
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

  close() {
    if (this.ws) this.ws.close();
  }
}

const derivAPI = new DerivConnection();
