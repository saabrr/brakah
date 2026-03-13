# VaultBet — Real Crypto Gambling Platform

A fully real-time, provably fair crypto gambling site with WebSocket multiplayer,
real authentication, email verification, Discord OAuth, real database, and live chat.

## Project Structure

```
vaultbet/
├── server/
│   ├── index.js     — Express + WebSocket server
│   ├── auth.js      — Login, register, Discord OAuth, email verify
│   ├── game.js      — Provably fair Slide game engine
│   ├── ws.js        — WebSocket message handler (chat, bets, tips, rain)
│   └── db.js        — SQLite database + all prepared statements
├── public/
│   └── index.html   — Full frontend (real WS client, no fake data)
├── data/            — Created automatically (SQLite DB lives here)
├── .env.example     — Copy this to .env and fill in your values
└── package.json
```

## Quick Start

### 1. Install Node.js (v18+)
```bash
# Check version
node -v
```

### 2. Install dependencies
```bash
cd vaultbet
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your values
```

### 4. Start the server
```bash
npm start
# Dev mode with auto-restart:
npm run dev
```

Visit http://localhost:3000

---

## Required Configuration (.env)

### SESSION_SECRET
Generate a secure random string:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Email (SMTP)
For Gmail:
1. Enable 2FA on your Google account
2. Go to myaccount.google.com → Security → App Passwords
3. Generate an app password
4. Set SMTP_USER=your@gmail.com and SMTP_PASS=the_app_password

Alternative: Use SendGrid, Mailgun, Resend (free tiers available)

### Discord OAuth
1. Go to https://discord.com/developers/applications
2. Create New Application → named "VaultBet"
3. Go to OAuth2 → Redirects → Add: http://localhost:3000/auth/discord/callback
4. Copy Client ID and Client Secret to .env
5. For production, update DISCORD_REDIRECT_URI to your domain

---

## Crypto Payments (Real Deposits)

To accept real crypto deposits, integrate a payment processor:

### Option A: NOWPayments (recommended, easy)
1. Sign up at nowpayments.io
2. Get API key
3. Create a deposit endpoint that generates a payment URL:

```js
// In server/index.js, add:
app.post('/api/create-deposit', requireAuth, async (req, res) => {
  const { coin } = req.body;
  const orderId = `deposit_${req.session.userId}_${Date.now()}`;

  const payment = await fetch('https://api.nowpayments.io/v1/payment', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.NOWPAYMENTS_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      price_amount: 10, // min deposit in USD
      price_currency: 'usd',
      pay_currency: coin,
      order_id: orderId,
      ipn_callback_url: `${process.env.SITE_URL}/api/deposit/confirm`,
    }),
  });
  const data = await payment.json();
  res.json({ address: data.pay_address, amount: data.pay_amount });
});
```

The `/api/deposit/confirm` webhook is already implemented — it credits the user on confirmation.

### Option B: CoinGate, Coinbase Commerce, BitPay
Similar integration pattern — all support IPN/webhook callbacks.

---

## Setting the Owner Account

1. Register normally at your site
2. Open a SQLite editor (DB Browser for SQLite, or command line):
```bash
sqlite3 data/vaultbet.db
UPDATE users SET role='owner' WHERE username='your_username';
```
3. Your username gets the gold OWNER badge in chat

---

## Production Deployment

### Option A: VPS (DigitalOcean, Linode, Hetzner)
```bash
# Install PM2 for process management
npm install -g pm2

# Start with PM2
pm2 start server/index.js --name vaultbet
pm2 save
pm2 startup

# Nginx reverse proxy (recommended)
# /etc/nginx/sites-available/vaultbet
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

# SSL with Certbot
certbot --nginx -d yourdomain.com
```

### Option B: Railway.app / Render.com (easier)
1. Push to GitHub
2. Connect repo to Railway/Render
3. Add environment variables in dashboard
4. Deploy — they handle SSL automatically

---

## Features Implemented

- ✅ Real user accounts (email/password + Discord OAuth)
- ✅ Email verification (with beautiful HTML emails)
- ✅ Password reset via email
- ✅ Secure bcrypt password hashing
- ✅ Session-based auth (30-day remember me)
- ✅ Real WebSocket connection (no polling)
- ✅ Provably fair crash game (HMAC-SHA256)
- ✅ Real-time multiplier broadcast to all players
- ✅ Auto-cashout support
- ✅ Real-time live chat (your messages only, no bots)
- ✅ Chat history (last 50 messages on join)
- ✅ Owner/Mod/VIP badge system
- ✅ Tip any online player (deducted from real balance)
- ✅ Rain — split amount among all online players
- ✅ Rate limiting (chat, bets, tips)
- ✅ WebSocket reconnection with exponential backoff
- ✅ SQLite database (swap for PostgreSQL for scale)
- ✅ Deposit webhook handler (ready for NOWPayments/CoinGate)
- ✅ Leaderboard API (/api/leaderboard)
- ✅ Round history API (/api/rounds) for provability
- ✅ Helmet security headers
- ✅ Rate limiting on auth routes

## Adding Real Money Balance (Testing)

While setting up crypto payments, you can manually add balance:
```bash
sqlite3 data/vaultbet.db
UPDATE users SET balance_sats = 100000 WHERE username='your_username';
-- balance_sats is in cents (100000 = $1000)
```
