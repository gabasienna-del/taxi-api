const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// --- health
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- auth
app.post('/auth/send-otp', (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ ok:false, error:'phone required' });
  // демо: отправку не делаем, просто возвращаем "1234"
  res.json({ ok: true, sent: true, debug_code: '1234' });
});

app.post('/auth/verify-otp', (req, res) => {
  const { phone, code } = req.body || {};
  if (!phone || !code) return res.status(400).json({ ok:false, error:'phone and code required' });
  if (code !== '1234') return res.status(400).json({ ok:false, error:'invalid code' });
  const token = jwt.sign({ sub: phone }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ ok: true, access_token: token });
});

// мидлвар для protected
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ ok:false, error:'no token' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok:false, error:'bad token' });
  }
}

// --- orders/quote (protected)
app.post('/orders/quote', auth, (req, res) => {
  const { from, to } = req.body || {};
  if (!Array.isArray(from) || !Array.isArray(to))
    return res.status(400).json({ ok:false, error:'from/to required' });
  // демо-цена
  const price = 700 + Math.round(Math.random()*300);
  res.json({ ok:true, price, currency:'KZT', eta_min: 3 + Math.round(Math.random()*5) });
});

// --- create order (protected)
app.post('/orders', auth, (req, res) => {
  const id = uuidv4();
  res.json({ ok:true, id, status:'new' });
});

// http server + ws
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/rt' });

wss.on('connection', (ws, req) => {
  // можно было бы проверять ?token=, но для демо не строжим
  ws.send(JSON.stringify({ type:'welcome', ts: Date.now() }));
  ws.on('message', (msg) => {
    let data = {};
    try { data = JSON.parse(msg); } catch {}
    if (data.type === 'driver_position') {
      ws.send(JSON.stringify({ type:'ack', ts: Date.now() }));
    }
  });
});

server.listen(PORT, () => {
  console.log('Server on', PORT);
});
