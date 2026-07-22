// ==========================================================
// AlgoTrade — ws.js (WebSocket Manager)
// ==========================================================

class DerivWS {
  constructor() {
    this.appId = window.APP_ID || "1089"; // Default fallback App ID
    this.wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    this.ws = null;
    this.reqId = 0;
    this.callbacks = new Map();
    this.subscriptions = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log("WebSocket Connected to Deriv");
        resolve();
      };

      this.ws.onerror = (err) => {
        console.error("WebSocket Error:", err);
        reject(err);
      };

      this.ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);

        // 1. Handle one-time request responses
        if (data.req_id && this.callbacks.has(data.req_id)) {
          const handler = this.callbacks.get(data.req_id);
          this.callbacks.delete(data.req_id);
          handler(data);
        }

        // 2. Handle continuous subscriptions (ticks, live prices)
        if (data.subscription) {
          const subId = data.subscription.id;
          if (this.subscriptions.has(subId)) {
            const callback = this.subscriptions.get(subId);
            callback(data);
          }
        }
      };

      this.ws.onclose = () => {
        console.warn("WebSocket Disconnected");
      };
    });
  }

  send(request) {
    return new Promise((resolve) => {
      this.reqId += 1;
      const reqId = this.reqId;
      const payload = { ...request, req_id: reqId };

      this.callbacks.set(reqId, (response) => {
        resolve(response);
      });

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
      } else {
        console.error("WebSocket is not open.");
      }
    });
  }

  subscribe(request, callback) {
    this.send({ ...request, subscribe: 1 }).then((response) => {
      if (response.subscription) {
        this.subscriptions.set(response.subscription.id, callback);
      }
    });

    // Return an unsubscribe function
    return () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ forget_all: "ticks" });
      }
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Global instance attached to window for all scripts to use
window.derivAPI = new DerivWS();
