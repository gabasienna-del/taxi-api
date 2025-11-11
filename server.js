const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = "devsecret";
const OTP_STORE = new Map();
const USERS = new Map();
const ORDERS = new Map();
const DRIVERS = new Map();

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

// healthcheck для Render
app.get("/health", (_, res) => res.json({ ok: true }));

// ===== AUTH =====
app.post("/auth/send-otp", (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone required" });
  const code = "1234";
  OTP_STORE.set(phone, code);
  res.json({ ok: true, sent: true, debug_code: code });
});

app.post("/auth/verify-otp", (req, res) => {
  const { phone, code } = req.body || {};
  const real = OTP_STORE.get(phone);
  if (code !== real) return res.status(401).json({ error: "wrong code" });
  if (!USERS.has(phone)) USERS.set(phone, uuid());
  const userId = USERS.get(phone);
  const token = jwt.sign({ sub: userId, phone }, SECRET, { expiresIn: "7d" });
  res.json({ access_token: token });
});

// ===== ORDERS =====
app.post("/orders/quote", auth, (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "from/to required" });
  const dist = 5.2, mins = 14;
  const price = 400 + dist * 100 + mins * 25;
  res.json({ distance_km: dist, minutes: mins, price });
});

app.post("/orders", auth, (req, res) => {
  const id = uuid();
  const order = { id, status: "searching", created_at: Date.now(), rider_id: req.user.sub };
  ORDERS.set(id, order);
  res.json(order);
});

app.get("/orders/:id", auth, (req, res) => {
  const o = ORDERS.get(req.params.id);
  if (!o) return res.status(404).json({ error: "not found" });
  res.json(o);
});

app.post("/orders/:id/cancel", auth, (req, res) => {
  const o = ORDERS.get(req.params.id);
  if (!o) return res.status(404).json({ error: "not found" });
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
  const offer = [...ORDERS.values()].find(o => o.status === "searching");
  res.json(offer ? [offer] : []);
});

app.post("/driver/offers/:id/accept", auth, (req, res) => {
  const o = ORDERS.get(req.params.id);
  if (!o) return res.status(404).json({ error: "not found" });
  o.status = "assigned";
  broadcast({ type: "order_status", orderId: o.id, status: o.status });
  res.json({ ok: true, orderId: o.id, status: o.status });
});

app.post("/driver/trip/:id/status", auth, (req, res) => {
  const o = ORDERS.get(req.params.id);
  if (!o) return res.status(404).json({ error: "not found" });
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
  ws.on("message", data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "driver_position") {
        broadcast(msg);
      }
    } catch {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("✅ API listening on port", PORT);
});
