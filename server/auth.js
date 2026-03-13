require('dotenv').config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getDb } = require('./db');

function stmts() { return getDb().stmts; }

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendVerifyEmail(email, username, token) {
  const link = `${process.env.SITE_URL}/auth/verify/${token}`;
  await mailer.sendMail({
    from: process.env.FROM_EMAIL,
    to: email,
    subject: `Verify your Barakahs account`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0d1117;color:#e8edf5;padding:32px;border-radius:12px;">
        <h2 style="color:#f5c842">Welcome to Barakahs!</h2>
        <p>Hi <strong>${username}</strong>, click below to verify your email:</p>
        <a href="${link}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#f5c842;color:#000;font-weight:700;text-decoration:none;border-radius:8px;">Verify Email</a>
        <p style="color:#8a9ab5;font-size:12px">Link expires in 24 hours.</p>
      </div>
    `,
  });
}

// REGISTER
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.json({ ok: false, error: 'All fields required' });
    if (username.length < 3 || username.length > 20) return res.json({ ok: false, error: 'Username must be 3-20 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.json({ ok: false, error: 'Username: letters, numbers, underscores only' });
    if (password.length < 8) return res.json({ ok: false, error: 'Password must be at least 8 characters' });
    if (stmts().getUserByUsername.get(username)) return res.json({ ok: false, error: 'Username already taken' });
    if (stmts().getUserByEmail.get(email)) return res.json({ ok: false, error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const token = crypto.randomBytes(32).toString('hex');

    // For local dev, auto-verify so you don't need email working
    const autoVerify = !process.env.SMTP_USER || process.env.SMTP_USER === 'yourgmail@gmail.com' ? 1 : 0;

    stmts().createUser.run({ username, email, password: hash, verify_token: token, verified: autoVerify });

    if (!autoVerify) {
      sendVerifyEmail(email, username, token).catch(console.error);
      return res.json({ ok: true, message: 'Account created! Check your email to verify.' });
    }

    // Auto-verified in dev mode — log them straight in
    const user = stmts().getUserByUsername.get(username);
    req.session.userId = user.id;
    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, balance: user.balance_sats } });

  } catch (err) {
    console.error('Register error:', err);
    res.json({ ok: false, error: 'Registration failed: ' + err.message });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'All fields required' });

    const user = stmts().getUserByEmail.get(username) || stmts().getUserByUsername.get(username);
    if (!user) return res.json({ ok: false, error: 'Invalid credentials' });
    if (!user.password) return res.json({ ok: false, error: 'Use Discord to log in' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.json({ ok: false, error: 'Invalid credentials' });
    if (!user.verified) return res.json({ ok: false, error: 'Please verify your email first' });

    stmts().updateLastSeen.run(user.id);
    req.session.userId = user.id;
    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, balance: user.balance_sats } });

  } catch (err) {
    console.error('Login error:', err);
    res.json({ ok: false, error: 'Login failed' });
  }
});

// VERIFY EMAIL
router.get('/verify/:token', (req, res) => {
  const result = stmts().updateVerified.run(req.params.token);
  if (!result.changes) return res.redirect('/?error=invalid_token');
  res.redirect('/?verified=1');
});

// FORGOT PASSWORD
router.post('/forgot', async (req, res) => {
  const { email } = req.body;
  const user = stmts().getUserByEmail.get(email);
  if (!user) return res.json({ ok: true });
  const token = crypto.randomBytes(32).toString('hex');
  stmts().setResetToken.run(token, Date.now() + 3600000, user.id);
  res.json({ ok: true, message: 'If that email exists, a reset link was sent.' });
});

// DISCORD OAUTH
router.get('/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

router.get('/discord/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=discord_cancelled');

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?error=discord_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();

    let user = stmts().getUserByDiscord.get(discordUser.id);
    if (!user) {
      let base = discordUser.username.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 18);
      let username = base, suffix = 1;
      while (stmts().getUserByUsername.get(username)) username = base + suffix++;
      stmts().upsertDiscord.run({ username, discord_id: discordUser.id });
      user = stmts().getUserByDiscord.get(discordUser.id);
    }

    stmts().updateLastSeen.run(user.id);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('Discord error:', err);
    res.redirect('/?error=discord_error');
  }
});

// LOGOUT
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// SESSION CHECK
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  const user = stmts().getUserById.get(req.session.userId);
  if (!user) return res.json({ ok: false });
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, balance: user.balance_sats } });
});

module.exports = router;