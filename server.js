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
const SMS_MODE = (process.env.SMS_MODE || 'demo').toLowerCase(); // demo | smsc | hybrid
const SMSC_LOGIN = process.env.SMSC_LOGIN || '';
const SMSC_PASSWORD = process.env.SMSC_PASSWORD || '';
const SMSC_SENDER = process.env.SMSC_SENDER || 'SMS';            // <- можно задать альфанейм

function genCode() { return Math.floor(1000 + Math.random()*9000).toString(); }

// in-memory
const OTP = new Map();
const ORDERS = new Map();

function normalizeKZ(phoneRaw) {
  // оставить только цифры
  let p = String(phoneRaw || '').replace(/\D+/g, '');
  // 8xxxxxxxxxx -> 7xxxxxxxxxx
  if (p.length === 11 && p.startsWith('8')) p = '7' + p.slice(1);
  // если оставили 10 цифр (без кода), добавим 7
  if (p.length === 10) p = '7' + p;
  return p; // без плюса
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, mode: SMS_MODE, base: BASE_URL });
});

app.post('/auth/send-otp', async (req, res) => {
  const phoneInput = req.body?.phone || '';
  const phoneNorm = normalizeKZ(phoneInput);
  if (!phoneNorm || phoneNorm.length !== 11 || !phoneNorm.startsWith('7')) {
    return res.status(400).json({ ok:false, error:'bad_phone_format', hint:'use +77XXXXXXXXX' });
  }

  const code = genCode();
  OTP.set(phoneNorm, { code, ts: Date.now() });

  async function sendViaSMSC() {
    const params = new URLSearchParams({
      login: SMSC_LOGIN,
      psw: SMSC_PASSWORD,
      phones: phoneNorm,                    // БЕЗ '+'
      mes: `Код подтверждения: ${code}`,
      fmt: '3',                             // JSON
      charset: 'utf-8',
      sender: SMSC_SENDER                   // если разрешён альфанейм
      // при необходимости можно добавить: translit: '0'
    });
    const r = await fetch(`https://smsc.kz/sys/send.php?${params.toString()}`);
    const data = await r.json().catch(() => ({}));
    // Успех у smsc: есть id и cnt (или нет error)
    const ok = data && !data.error && (data.id || data.cnt !== undefined);
    return { ok, data };
  }

  if (SMS_MODE === 'smsc' || SMS_MODE === 'hybrid') {
    try {
      const { ok, data } = await sendViaSMSC();
      if (ok) return res.json({ ok:true, sent:true, provider:'smsc', response:data });
      // smsc вернул ошибку
      if (SMS_MODE === 'hybrid') {
        return res.json({ ok:true, sent:false, provider:'hybrid_fallback', debug_code: code, response:data });
      }
      return res.status(502).json({ ok:false, error:'smsc_failed', response:data });
    } catch (e) {
      if (SMS_MODE === 'hybrid') {
        return res.json({ ok:true, sent:false, provider:'hybrid_error', debug_code: code, details:String(e) });
      }
      return res.status(502).json({ ok:false, error:'smsc_exception', details:String(e) });
    }
  }

  // demo
  return res.json({ ok:true, sent:true, provider:'demo', debug_code: code });
});

app.post('/auth/verify-otp', (req, res) => {
  const phoneNorm = normalizeKZ(req.body?.phone || '');
  const code = String(req.body?.code || '').trim();
  const rec = OTP.get(phoneNorm);
  if (!rec || rec.code !== code) return res.status(400).json({ ok:false, error:'invalid code' });
  OTP.delete(phoneNorm);
  const token = jwt.sign({ sub: phoneNorm }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ ok:true, access_token: token });
});

// ===== ORDERS (demo) =====
app.post('/orders/quote', (req, res) => {
  res.json({ ok:true, price:967, currency:'KZT', eta_min:7 });
});
app.post('/orders', (req, res) => {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  ORDERS.set(id, { id, status:'new' });
  res.json({ ok:true, id, status:'new' });
});

// ===== WS =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/rt' });
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type:'welcome', ts: Date.now() }));
  ws.on('message', data => {
    try { const msg = JSON.parse(String(data)); if (msg.type === 'driver_position') broadcast(msg); } catch {}
  });
});

// START
server.listen(PORT, () => console.log('API listening on', PORT, 'mode=', SMS_MODE));
