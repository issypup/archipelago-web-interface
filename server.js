import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const webClients = new Set();

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

wss.on("connection", (browserSocket, req) => {
  console.log("[WS] Browser connected", req.socket.remoteAddress);
  webClients.add(browserSocket);

  let apSocket = null;
  let currentApUrl = null;

  function sendToBrowser(type, data = {}) {
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(JSON.stringify({ type, ...data }));
    }
  }

const sendQueue = [];
let sending = false;

function queueSend(payload) {
  sendQueue.push(payload);
  processQueue();
}

function processQueue() {
  if (sending || !apSocket || apSocket.readyState !== WebSocket.OPEN) return;

  const next = sendQueue.shift();
  if (!next) return;

  sending = true;
  apSocket.send(JSON.stringify(next), () => {
    sending = false;
    setTimeout(processQueue, 50); // throttle
  });
}


  function closeApSocket() {
    if (apSocket) {
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
  }

  browserSocket.on("message", (raw) => {
    console.log("[WS] Browser -> server", raw.toString());

    const msg = safeJsonParse(raw.toString());
    if (!msg || !msg.type) return;

if (msg.type === "connect-ap") {
  closeApSocket();

  let apUrl = String(msg.apUrl || "").trim();

  if (/^ws:\/\/archipelago\.gg(?::\d+)?$/i.test(apUrl)) {
    apUrl = apUrl.replace(/^ws:\/\//i, "wss://");
  }

  if (!/^wss?:\/\//i.test(apUrl)) {
    sendToBrowser("error", {
      message: "Archipelago URL must start with ws:// or wss://"
    });
    return;
  }

currentApUrl = apUrl;
console.log("[AP] Connecting to", currentApUrl);

try {
  apSocket = new WebSocket(apUrl);
} catch (err) {
  console.error("[AP] Invalid WebSocket URL:", err);
  sendToBrowser("error", {
    message: `Invalid Archipelago URL: ${apUrl}`
  });
  currentApUrl = null;
  apSocket = null;
  return;
}

      apSocket.on("open", () => {
        console.log("[AP] Connected to", currentApUrl);
        sendToBrowser("ap-open", { apUrl: currentApUrl });
      });

      apSocket.on("message", (data) => {
        const text = data.toString();
        console.log("[AP] Message received", text.slice(0, 300));
        const parsed = safeJsonParse(text);
        sendToBrowser("ap-message", { raw: text, packets: parsed });
      });

      apSocket.on("close", (code, reason) => {
        console.log("[AP] Closed", { code, reason: reason?.toString() });
        sendToBrowser("ap-close", { code, reason: reason?.toString() });
      });

      apSocket.on("error", (err) => {
        console.error("[AP] Socket error:", err);
        sendToBrowser("error", {
          message: `Archipelago socket error: ${err.message}`
        });
      });

      return;
    }

    if (msg.type === "disconnect-ap") {
      console.log("[AP] Disconnect requested by browser");
      closeApSocket();
      sendToBrowser("ap-close", {});
      return;
    }

if (msg.type === "send-ap") {
  if (!apSocket || apSocket.readyState !== WebSocket.OPEN) {
    sendToBrowser("error", {
      message: "Not connected to Archipelago server."
    });
    return;
  }

  const payload = msg.payload;
  const packets = Array.isArray(payload) ? payload : [payload];

  console.log("[AP] Sending payload", JSON.stringify(packets));

  queueSend(packets); // or apSocket.send(JSON.stringify(packets))
  return;
}
  });

  browserSocket.on("close", (code, reason) => {
    console.log("[WS] Browser socket closed", { code, reason: reason?.toString() });
    webClients.delete(browserSocket);
    closeApSocket();
  });

  browserSocket.on("error", (err) => {
    console.error("[WS] Browser socket error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Archipelago web panel running on http://localhost:${PORT}`);
});