const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const http = require("http");
const WebSocket = require("ws");

// ==== ENV ====
const SECRET = process.env.JWT_SECRET || "devsecret";
const SMS_MODE = (process.env.SMS_MODE || "demo").toLowerCase(); // demo | smsc
const SMSC_LOGIN = process.env.SMSC_LOGIN || "";
const SMSC_PASSWORD = process.env.SMSC_PASSWORD || "";
const SMSC_SENDER = process.env.SMSC_SENDER || "TAXI";
const BASE_URL = process.env.BASE_URL || "";

// ==== APP ====
const app = express();
app.use(cors());
app.use(express.json());

const OTP_STORE = new Map();  // phone -> code
const USERS = new Map();      // phone -> userId
const ORDERS = new Map();
const DRIVERS = new Map();

// ===== helpers =====
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no token" });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: "bad token" });
  }
}

function randCode4() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Отправка через smsc.kz
async function sendViaSMSC(phone, text) {
  const params = new URLSearchParams({
    login: SMSC_LOGIN,
    psw: SMSC_PASSWORD,
    phones: phone,
    mes: text,
    fmt: "3",            // JSON
    charset: "utf-8",
    sender: SMSC_SENDER
  });

  const resp = await fetch("https://smsc.kz/sys/send.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  // Пытаемся всегда распарсить JSON
  let data = null;
  try { data = await resp.json(); } catch { data = null; }

  if (!resp.ok) {
    throw new Error(`SMSC HTTP ${resp.status}`);
  }
  if (data && (data.error || data.error_code)) {
    throw new Error(`SMSC error: ${data.error || data.error_code}`);
  }
  return data || {};
}

// ===== health =====
app.get("/health", (_, res) => {
  res.json({ ok: true, mode: SMS_MODE, base: BASE_URL || undefined });
});

// ===== AUTH =====
app.post("/auth/send-otp", async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone || !/^\+7\d{10}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: "phone format +7XXXXXXXXXX required" });
    }
    const code = SMS_MODE === "demo" ? "1234" : randCode4();
    OTP_STORE.set(phone, code);

    if (SMS_MODE === "smsc") {
      // отправляем реальный SMS
      await sendViaSMSC(phone, `Код подтверждения: ${code}`);
      // в бою НЕ выдаём код в ответе
      return res.json({ ok: true, sent: true });
    } else {
      // demo-режим — для удобства возвращаем код
      return res.json({ ok: true, sent: true, debug_code: code });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/auth/verify-otp", (req, res) => {
  const { phone, code } = req.body || {};
  const real = OTP_STORE.get(phone);
  if (!phone || !code) return res.status(400).json({ ok: false, error: "phone and code required" });
  if (code !== real) return res.status(401).json({ ok: false, error: "invalid code" });

  if (!USERS.has(phone)) USERS.set(phone, uuid());
  const userId = USERS.get(phone);
  const token = jwt.sign({ sub: userId, phone }, SECRET, { expiresIn: "7d" });
  res.json({ access_token: token });
});

// ===== ORDERS =====
app.post("/orders/quote", auth, (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ ok: false, error: "from/to required" });
  // простая демо-логика
  const dist = 5.2, mins = 7;
  const price = 400 + Math.round(dist * 100) + mins * 25;
  res.json({ ok: true, price, currency: "KZT", eta_min: mins });
});

app.post("/orders", auth, (req, res) => {
  const id = uuid();
  const order = { id, status: "new", created_at: Date.now(), rider_id: req.user.sub };
  ORDERS.set(id, order);
  res.json({ ok: true, ...order });
});

app.get("/orders/:id", auth, (req, res) => {
  const o = ORDERS.get(req.params.id);
  if (!o) return res.status(404).json({ ok: false, error: "not found" });
  res.json(o);
});

app.post("/orders/:id/cancel", auth, (req, res) => {
  const o = ORDERS.get(req.params.id);
  if (!o) return res.status(404).json({ ok: false, error: "not found" });
  o.status = "cancelled";
  broadcast({ type: "order_status", orderId: o.id, status: o.status });
  res.json({ ok: true, status: o.status });
});

// ===== DRIVER =====
app.post("/driver/status", auth, (req, res) => {
  const { status } = req.body || {};
  DRIVERS.set(req.user.sub, { status });
  res.json({ ok: true, status });
});

app.get("/driver/offers", auth, (req, res) => {
  const offer = [...ORDERS.values()].find(o => o.status === "new");
  res.json(offer ? [offer] : []);
});

app.post("/driver/offers/:id/accept", auth, (req, res) => {
  const o = ORDERS.get(req.params.id);
  if (!o) return res.status(404).json({ ok: false, error: "not found" });
  o.status = "assigned";
  broadcast({ type: "order_status", orderId: o.id, status: o.status });
  res.json({ ok: true, orderId: o.id, status: o.status });
});

app.post("/driver/trip/:id/status", auth, (req, res) => {
  const o = ORDERS.get(req.params.id);
  if (!o) return res.status(404).json({ ok: false, error: "not found" });
  const { status } = req.body || {};
  o.status = status;
  broadcast({ type: "order_status", orderId: o.id, status });
  res.json({ ok: true, status });
});

// ===== WEBSOCKET =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/rt" });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

wss.on("connection", ws => {
  ws.send(JSON.stringify({ type: "welcome", ts: Date.now() }));
  ws.on("message", data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "driver_position") broadcast(msg);
    } catch {}
  });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("✅ API listening on port", PORT, "mode:", SMS_MODE);
});
