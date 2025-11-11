const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  console.log('OTP send to:', phone);
  res.json({ ok: true, sent: true, debug_code: '1234' });
});

app.post('/auth/verify-otp', (req, res) => {
  const { phone, code } = req.body;
  if (code === '1234') return res.json({ access_token: 'demo.jwt.token' });
  res.status(401).json({ error: 'Invalid code' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API running on port ${PORT}`));
