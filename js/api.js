// ==========================================================
// AlgoTrade — api.js
// A single persistent WebSocket connection to Deriv, shared by the
// whole app. Connects using the OTP-embedded URL obtained from the
// REST accounts/otp endpoint (see auth.js) — the OTP already
// authenticates the connection, so there's no separate "authorize"
// step like the old API required.
//
// Subscriptions are routed primarily by Deriv's own `subscription.id`,
// not by our `req_id` — the new API doesn't reliably echo req_id back
// on every push after the first, only on the initial confirmation.
// Routing solely by req_id silently drops every push after that first
// one, which is what was freezing the digits widget.
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
    this.pending = new Map();          // req_id -> {resolve, reject}
    this.subscriptions = new Map();    // req_id -> callback (used to catch the first push)
    this.subscriptionsById = new Map();// deriv subscription.id -> callback (used for every push after)
    this.reqIdToSubId = new Map();     // req_id -> deriv subscription.id, for clean unsubscribe
    this.cancelledReqIds = new Set();  // cancelled before their subscription.id arrived -> forget on first push
    this.connectPromise = null;
    this.currentUrl = null;
    this.onStatusChange = null;
    this.onDisconnected = null;   // set externally (auth.js) to get a fresh OTP and reconnect
    this.keepaliveTimer = null;
    this.deliberateClose = false; // true when WE closed it (e.g. Disconnect button) — skip auto-reconnect
  }

  _startKeepalive() {
    clearInterval(this.keepaliveTimer);
    // Deriv closes idle sessions after 2 minutes; ping well under that
    // so an active session should never actually hit the timeout.
    this.keepaliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ ping: 1 }).catch(() => {});
      }
    }, 25000);
  }

  _stopKeepalive() {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  connectToUrl(wsUrl) {
    this.currentUrl = wsUrl;
    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        if (this.onStatusChange) this.onStatusChange("connected");
        this._startKeepalive();
        resolve();
      };

      this.ws.onmessage = (event) => this._handleMessage(event);

      this.ws.onerror = (err) => {
        if (this.onStatusChange) this.onStatusChange("error");
        reject(err);
      };

      this.ws.onclose = () => {
        if (this.onStatusChange) this.onStatusChange("disconnected");
        this._stopKeepalive();
        this.connectPromise = null;
        // OTPs are single-use and only valid ~120s, so we can't just
        // reconnect to the same URL — a fresh OTP (and a resubscribe of
        // everything) is needed. That's handled externally since it
        // needs the access token / active account (auth.js's domain).
        if (!this.deliberateClose && this.onDisconnected) {
          this.onDisconnected();
        }
        this.deliberateClose = false;
      };
    });

    return this.connectPromise;
  }

  _resolvePending(data) {
    if (data.req_id !== undefined && this.pending.has(data.req_id)) {
      const { resolve, reject } = this.pending.get(data.req_id);
      this.pending.delete(data.req_id);
      data.error ? reject(new Error(data.error.message)) : resolve(data);
    }
  }

  _handleMessage(event) {
    const data = JSON.parse(event.data);
    const subId = data.subscription?.id;

    // Turn on from the browser console with:  DERIV_DEBUG = true
    if (window.DERIV_DEBUG) {
      console.log("[deriv <-]", data.msg_type, "req_id:", data.req_id, "sub:", subId,
        data.error ? "ERROR: " + data.error.message : "");
    }

    // A subscription that was cancelled before its id had arrived: now that
    // we finally know the id, forget exactly that one stream (never a whole
    // category, which could take unrelated streams like ticks down with it).
    if (subId && data.req_id !== undefined && this.cancelledReqIds.has(data.req_id)) {
      this.cancelledReqIds.delete(data.req_id);
      this.send({ forget: subId }).catch(() => {});
      return;
    }

    // Every push after the first for a given subscription routes here,
    // whether or not it carries our req_id.
    if (subId && this.subscriptionsById.has(subId)) {
      this.subscriptionsById.get(subId)(data);
      this._resolvePending(data);
      return;
    }

    // First push for a subscription (or a plain one-off response).
    if (data.req_id !== undefined && this.subscriptions.has(data.req_id)) {
      const cb = this.subscriptions.get(data.req_id);
      if (subId) {
        this.subscriptionsById.set(subId, cb);
        this.reqIdToSubId.set(data.req_id, subId);
      }
      cb(data);
      this._resolvePending(data);
      return;
    }

    this._resolvePending(data);
  }

  /** Send a one-off request, resolves with the full response. */
  send(request) {
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqId;
      this.pending.set(reqId, { resolve, reject });
      if (window.DERIV_DEBUG) console.log("[deriv ->]", Object.keys(request)[0], "req_id:", reqId);
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
    if (window.DERIV_DEBUG) console.log("[deriv -> sub]", Object.keys(request)[0], "req_id:", reqId);
    this.ws.send(JSON.stringify({ ...request, subscribe: 1, req_id: reqId }));

    return async () => {
      const subId = this.reqIdToSubId.get(reqId);
      this.subscriptions.delete(reqId);
      this.reqIdToSubId.delete(reqId);
      if (subId) this.subscriptionsById.delete(subId);

      try {
        if (subId) {
          // Precise: forget only this one subscription.
          await this.send({ forget: subId });
        } else {
          // Id not known yet: remember to forget it the moment it arrives.
          // (No forget_all fallbacks — those can cancel unrelated streams.)
          this.cancelledReqIds.add(reqId);
        }
      } catch (_) { /* best effort */ }
    };
  }

  close() {
    this.deliberateClose = true;
    this._stopKeepalive();
    if (this.ws) this.ws.close();
  }
}

const derivAPI = new DerivConnection();
