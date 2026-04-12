import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/* ============================================================================
 * Configuration
 * ========================================================================== */

/**
 * Port used by the Express/WS server.
 * Falls back to 3000 when no environment variable is provided.
 * @type {number|string}
 */
const PORT = process.env.PORT || 3000;

/* ============================================================================
 * Express App / HTTP Server Setup
 * ========================================================================== */

const app = express();
const server = http.createServer(app);

/**
 * Middleware:
 * - Parses JSON request bodies up to 1 MB
 * - Serves static files from the "public" folder
 */
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
app.use(express.static("public"));

/* ============================================================================
 * Shared State
 * ========================================================================== */

/**
 * Tracks all connected browser clients.
 * Useful if you later want to broadcast updates to every open web panel.
 * @type {Set<WebSocket>}
 */
const webClients = new Set();

/* ============================================================================
 * Utility Helpers
 * ========================================================================== */

/**
 * Safely parse a JSON string.
 *
 * Returns `null` instead of throwing when the input is invalid JSON.
 *
 * @param {string} text - Raw JSON string.
 * @returns {any | null} Parsed object/array if valid, otherwise null.
 */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Send a JSON message to a browser WebSocket if it is open.
 *
 * @param {WebSocket} browserSocket - Browser WebSocket connection.
 * @param {string} type - Message type to send.
 * @param {object} [data={}] - Extra payload fields to include.
 * @returns {void}
 */
function sendToBrowser(browserSocket, type, data = {}) {
  if (browserSocket.readyState === WebSocket.OPEN) {
    browserSocket.send(JSON.stringify({ type, ...data }));
  }
}

/* ============================================================================
 * WebSocket Server Setup
 * ========================================================================== */

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

/* ============================================================================
 * Browser Connection Handling
 * ========================================================================== */

wss.on("connection", (browserSocket, req) => {
  console.log("[WS] Browser connected", req.socket.remoteAddress);
  webClients.add(browserSocket);

  /**
   * Active Archipelago socket associated with this browser connection.
   * @type {WebSocket | null}
   */
  let apSocket = null;

  /**
   * Current Archipelago server URL for this browser session.
   * @type {string | null}
   */
  let currentApUrl = null;

  /**
   * Queue of outbound payloads waiting to be sent to Archipelago.
   * This is used to avoid rapid back-to-back sends.
   * @type {any[]}
   */
  const sendQueue = [];

  /**
   * Whether a queued send is currently in progress.
   * @type {boolean}
   */
  let sending = false;

  /* --------------------------------------------------------------------------
   * Archipelago Send Queue Helpers
   * ------------------------------------------------------------------------ */

  /**
   * Add a payload to the outgoing Archipelago send queue.
   *
   * @param {any} payload - Packet or packet array to send.
   * @returns {void}
   */
  function queueSend(payload) {
    sendQueue.push(payload);
    processQueue();
  }

  /**
   * Process the next queued Archipelago payload.
   *
   * Sends one item at a time with a short delay to avoid flooding.
   *
   * @returns {void}
   */
  function processQueue() {
    if (sending || !apSocket || apSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const next = sendQueue.shift();
    if (!next) return;

    sending = true;

    apSocket.send(JSON.stringify(next), () => {
      sending = false;
      setTimeout(processQueue, 50); // Simple throttle between sends
    });
  }

  /* --------------------------------------------------------------------------
   * Archipelago Connection Helpers
   * ------------------------------------------------------------------------ */

  /**
   * Close the currently connected Archipelago socket, if one exists.
   *
   * Clears local state after closing.
   *
   * @returns {void}
   */
  function closeApSocket() {
    if (!apSocket) return;

    try {
      console.log("[AP] Closing AP socket", currentApUrl);
      apSocket.removeAllListeners();
      apSocket.close();
    } catch (err) {
      console.error("[AP] Error while closing AP socket:", err);
    }

    apSocket = null;
    currentApUrl = null;
  }

  /**
   * Normalize and validate an Archipelago WebSocket URL.
   *
   * Special case:
   * - Converts ws://archipelago.gg to wss://archipelago.gg
   *
   * @param {string} rawUrl - User-provided URL.
   * @returns {{ valid: true, url: string } | { valid: false, message: string }}
   */
  function normalizeApUrl(rawUrl) {
    let apUrl = String(rawUrl || "").trim();

    if (/^ws:\/\/archipelago\.gg(?::\d+)?$/i.test(apUrl)) {
      apUrl = apUrl.replace(/^ws:\/\//i, "wss://");
    }

    if (!/^wss?:\/\//i.test(apUrl)) {
      return {
        valid: false,
        message: "Archipelago URL must start with ws:// or wss://"
      };
    }

    return {
      valid: true,
      url: apUrl
    };
  }

  /**
   * Attach event listeners to a newly created Archipelago socket.
   *
   * @param {WebSocket} socket - Archipelago WebSocket.
   * @returns {void}
   */
  function attachApSocketHandlers(socket) {
    socket.on("open", () => {
      console.log("[AP] Connected to", currentApUrl);
      sendToBrowser(browserSocket, "ap-open", { apUrl: currentApUrl });
      processQueue();
    });

    socket.on("message", (data) => {
      const text = data.toString();
      console.log("[AP] Message received", text.slice(0, 300));

      const parsed = safeJsonParse(text);

      sendToBrowser(browserSocket, "ap-message", {
        raw: text,
        packets: parsed
      });
    });

    socket.on("close", (code, reason) => {
      console.log("[AP] Closed", {
        code,
        reason: reason?.toString()
      });

      sendToBrowser(browserSocket, "ap-close", {
        code,
        reason: reason?.toString()
      });
    });

    socket.on("error", (err) => {
      console.error("[AP] Socket error:", err);

      sendToBrowser(browserSocket, "error", {
        message: `Archipelago socket error: ${err.message}`
      });
    });
  }

  /* --------------------------------------------------------------------------
   * Browser -> Server Message Handling
   * ------------------------------------------------------------------------ */

  browserSocket.on("message", (raw) => {
    const text = raw.toString();
    console.log("[WS] Browser -> server", text);

    const msg = safeJsonParse(text);
    if (!msg || !msg.type) return;

    /**
     * Connect browser session to an Archipelago server.
     */
    if (msg.type === "connect-ap") {
      closeApSocket();

      const normalized = normalizeApUrl(msg.apUrl);
      if (!normalized.valid) {
        sendToBrowser(browserSocket, "error", {
          message: normalized.message
        });
        return;
      }

      currentApUrl = normalized.url;
      console.log("[AP] Connecting to", currentApUrl);

      try {
        apSocket = new WebSocket(currentApUrl);
      } catch (err) {
        console.error("[AP] Invalid WebSocket URL:", err);

        sendToBrowser(browserSocket, "error", {
          message: `Invalid Archipelago URL: ${currentApUrl}`
        });

        currentApUrl = null;
        apSocket = null;
        return;
      }

      attachApSocketHandlers(apSocket);
      return;
    }

    /**
     * Disconnect from the current Archipelago server.
     */
    if (msg.type === "disconnect-ap") {
      console.log("[AP] Disconnect requested by browser");
      closeApSocket();
      sendToBrowser(browserSocket, "ap-close", {});
      return;
    }

    /**
     * Forward a packet or packet array to the Archipelago server.
     */
    if (msg.type === "send-ap") {
      if (!apSocket || apSocket.readyState !== WebSocket.OPEN) {
        sendToBrowser(browserSocket, "error", {
          message: "Not connected to Archipelago server."
        });
        return;
      }

      const payload = msg.payload;
      const packets = Array.isArray(payload) ? payload : [payload];

      console.log("[AP] Sending payload", JSON.stringify(packets));
      queueSend(packets);
    }
  });

  /* --------------------------------------------------------------------------
   * Browser Socket Lifecycle
   * ------------------------------------------------------------------------ */

  browserSocket.on("close", (code, reason) => {
    console.log("[WS] Browser socket closed", {
      code,
      reason: reason?.toString()
    });

    webClients.delete(browserSocket);
    closeApSocket();
  });

  browserSocket.on("error", (err) => {
    console.error("[WS] Browser socket error:", err);
  });
});

/* ============================================================================
 * Server Start
 * ========================================================================== */

server.listen(PORT, () => {
  console.log(`Archipelago web panel running on http://localhost:${PORT}`);
});