require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const { initDb, getDb } = require('./db');

async function startServer() {
  await initDb();
  const { stmts } = getDb();

  const app = express();
  const server = http.createServer(app);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, '../public')));

  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  });
  app.use(sessionMiddleware);

  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws, req) => {
    sessionMiddleware(req, {}, () => {
      ws.userId = req.session?.userId || null;
      if (ws.userId) {
        const user = stmts.getUserById.get(ws.userId);
        if (user) ws.user = { id: user.id, username: user.username, role: user.role };
      }
    });
  });

  app.get('/admin/givemoney', (req, res) => {
  const { stmts } = getDb();
  stmts.updateBalance.run(10000, 1);
  res.json({ ok: true });
});

app.get('/setup', (req, res) => {
  const { stmts } = getDb();
  stmts.updateBalance.run(10000, 1);
  getDb().run("UPDATE users SET role='owner' WHERE id=1");
  res.json({ ok: true, message: 'Done! Remove this endpoint now.' });
});

  const { SlideGame } = require('./game');
  const { setupWebSocket } = require('./ws');
  const game = new SlideGame(wss);
  setupWebSocket(wss, game);

  app.use('/auth', require('./auth'));

  // Create deposit address via NOWPayments
  app.post('/api/deposit/create', express.json(), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not logged in' });
    const { coin } = req.body;
    if (!['btc', 'ltc', 'eth'].includes(coin)) return res.json({ ok: false, error: 'Invalid coin' });
    if (!process.env.NOWPAYMENTS_API_KEY) return res.json({ ok: false, error: 'Payments not configured' });

    try {
      const r = await fetch('https://api.nowpayments.io/v1/payment', {
        method: 'POST',
        headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price_amount: 1,
          price_currency: 'usd',
          pay_currency: coin,
          order_id: `deposit_${req.session.userId}_${Date.now()}`,
          order_description: 'Barakahs deposit',
          ipn_callback_url: `${process.env.SITE_URL}/api/deposit/confirm`,
          is_fixed_rate: false,
          is_fee_paid_by_user: false,
        }),
      });
      const data = await r.json();
      if (!data.pay_address) return res.json({ ok: false, error: data.message || 'Could not generate address' });
      stmts.createDeposit.run(req.session.userId, coin, data.pay_address);
      res.json({ ok: true, address: data.pay_address, coin });
    } catch (e) {
      console.error(e);
      res.json({ ok: false, error: 'Payment service error' });
    }
  });

  // IPN webhook from NOWPayments
  app.post('/api/deposit/confirm', express.raw({ type: '*/*' }), (req, res) => {
    const sig = req.headers['x-nowpayments-sig'];
    if (sig && process.env.NOWPAYMENTS_IPN_SECRET) {
      const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET).update(req.body).digest('hex');
      if (hmac !== sig) return res.status(401).end();
    }
    let p;
    try { p = JSON.parse(req.body.toString()); } catch { return res.status(400).end(); }
    if (p.payment_status !== 'confirmed' && p.payment_status !== 'finished') return res.json({ ok: true });
    const userId = parseInt((p.order_id || '').split('_')[1]);
    if (!userId) return res.status(400).end();
    const cents = Math.round(parseFloat(p.price_amount || 0) * 100);
    if (cents <= 0) return res.status(400).end();
    stmts.updateBalance.run(cents, userId);
    console.log(`✅ Deposit: user ${userId} +$${(cents / 100).toFixed(2)}`);
    wss.clients.forEach(c => {
      if (c.readyState === 1 && c.userId === userId) {
        const bal = stmts.getBalance.get(userId);
        c.send(JSON.stringify({ type: 'depositConfirmed', amountCents: cents, balance: bal?.balance_sats }));
      }
    });
    res.json({ ok: true });
  });

  app.get('/api/leaderboard', (req, res) => res.json(stmts.leaderboard.all()));
  app.get('/api/rounds', (req, res) => res.json(stmts.lastRounds.all(50).map(r => ({
    roundId: r.round_id, crashPoint: r.crash_point / 100, hash: r.hash, seed: r.seed,
  }))));

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n🎰 Barakahs → http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready`);
    console.log(`🗄  Database ready\n`);
  });
}

startServer().catch(e => { console.error('Startup failed:', e); process.exit(1); });