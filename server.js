const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const http = require('http');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ==== ENV ====
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const SMS_MODE = (process.env.SMS_MODE || 'demo').toLowerCase();
const SMSC_LOGIN = process.env.SMSC_LOGIN || '';
const SMSC_PASSWORD = process.env.SMSC_PASSWORD || '';

function genCode() {
  return Math.floor(1000 + Math.random()*9000).toString();
}

// простая in-memory "база"
const OTP = new Map();
const ORDERS = new Map();

// ==== HEALTH ====
app.get('/health', (_req, res) => {
  res.json({ ok: true, mode: SMS_MODE, base: BASE_URL });
});

// ==== AUTH ====
app.post('/auth/send-otp', async (req, res) => {
  const phone = (req.body?.phone || '').trim();
  if (!phone) return res.status(400).json({ ok:false, error: 'phone required' });

  const code = genCode();
  OTP.set(phone, { code, ts: Date.now() });

  if (SMS_MODE === 'smsc') {
    try {
      const params = new URLSearchParams({
        login: SMSC_LOGIN,
        psw: SMSC_PASSWORD,
        phones: phone,
        mes: `Код подтверждения: ${code}`,
        fmt: '3'                 // JSON-ответ
      });
      const r = await fetch(`https://smsc.kz/sys/send.php?${params.toString()}`);
      const data = await r.json().catch(() => ({}));
      // если у smsc всё ок — не светим код
      return res.json({ ok: true, sent: true, provider: 'smsc', response: data });
    } catch (e) {
      return res.status(502).json({ ok:false, error:'smsc_failed', details: String(e) });
    }
  }

  // demo-режим — возвращаем debug_code
  return res.json({ ok: true, sent: true, debug_code: code, provider: 'demo' });
});

app.post('/auth/verify-otp', (req, res) => {
  const phone = (req.body?.phone || '').trim();
  const code = (req.body?.code || '').trim();
  const rec = OTP.get(phone);
  if (!rec || rec.code !== code) return res.status(400).json({ ok:false, error:'invalid code' });

  OTP.delete(phone);
  const token = jwt.sign({ sub: phone }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ ok:true, access_token: token });
});

// ==== ORDERS (упрощённо) ====
app.post('/orders/quote', (req, res) => {
  res.json({ ok:true, price: 967, currency: 'KZT', eta_min: 7 });
});

app.post('/orders', (req, res) => {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  ORDERS.set(id, { id, status:'new' });
  res.json({ ok:true, id, status:'new' });
});

// ==== WS для событий ====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/rt' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type:'welcome', ts: Date.now() }));
  ws.on('message', data => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === 'driver_position') broadcast(msg);
    } catch {}
  });
});

// ==== START ====
server.listen(PORT, () => {
  console.log('API listening on', PORT, 'mode=', SMS_MODE);
});
