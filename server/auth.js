// server/auth.js — Authentication routes
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getDb } = require('./db');
function getStmts() { return getDb().stmts; }

// ── EMAIL TRANSPORT ──
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
    subject: `Verify your ${process.env.SITE_NAME} account`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0d1117;color:#e8edf5;padding:32px;border-radius:12px;">
        <h2 style="color:#f5c842">Welcome to ${process.env.SITE_NAME}!</h2>
        <p>Hi <strong>${username}</strong>, verify your email to start playing:</p>
        <a href="${link}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#f5c842;color:#000;font-weight:700;text-decoration:none;border-radius:8px;">
          Verify Email
        </a>
        <p style="color:#8a9ab5;font-size:12px">Link expires in 24 hours. If you didn't register, ignore this email.</p>
      </div>
    `,
  });
}

async function sendResetEmail(email, username, token) {
  const link = `${process.env.SITE_URL}/auth/reset/${token}`;
  await mailer.sendMail({
    from: process.env.FROM_EMAIL,
    to: email,
    subject: `Reset your ${process.env.SITE_NAME} password`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0d1117;color:#e8edf5;padding:32px;border-radius:12px;">
        <h2 style="color:#f5c842">Password Reset</h2>
        <p>Hi <strong>${username}</strong>, click below to reset your password:</p>
        <a href="${link}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#f5c842;color:#000;font-weight:700;text-decoration:none;border-radius:8px;">
          Reset Password
        </a>
        <p style="color:#8a9ab5;font-size:12px">Link expires in 1 hour.</p>
      </div>
    `,
  });
}

// ── REGISTER ──
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password)
      return res.json({ ok: false, error: 'All fields required' });

    if (username.length < 3 || username.length > 20)
      return res.json({ ok: false, error: 'Username must be 3-20 characters' });

    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return res.json({ ok: false, error: 'Username: letters, numbers, underscores only' });

    if (password.length < 8)
      return res.json({ ok: false, error: 'Password must be at least 8 characters' });

    // Check duplicates
    if (getStmts().getUserByUsername.get(username))
      return res.json({ ok: false, error: 'Username already taken' });

    if (getStmts().getUserByEmail.get(email))
      return res.json({ ok: false, error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const token = crypto.randomBytes(32).toString('hex');

    getStmts().createUser.run({ username, email, password: hash, verify_token: token, verified: 0 });

    // Send verification email (non-blocking)
    sendVerifyEmail(email, username, token).catch(console.error);

    res.json({ ok: true, message: 'Account created! Check your email to verify.' });
  } catch (err) {
    console.error('Register error:', err);
    res.json({ ok: false, error: 'Registration failed. Try again.' });
  }
});

// ── LOGIN ──
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ ok: false, error: 'All fields required' });

    // Try email or username
    const user = getStmts().getUserByEmail.get(username) || getStmts().getUserByUsername.get(username);
    if (!user) return res.json({ ok: false, error: 'Invalid credentials' });

    if (!user.password) return res.json({ ok: false, error: 'Use Discord to log in' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.json({ ok: false, error: 'Invalid credentials' });

    if (!user.verified)
      return res.json({ ok: false, error: 'Please verify your email first' });

    getStmts().updateLastSeen.run(user.id);
    req.session.userId = user.id;

    res.json({
      ok: true,
      user: { id: user.id, username: user.username, role: user.role, balance: user.balance_sats },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.json({ ok: false, error: 'Login failed' });
  }
});

// ── VERIFY EMAIL ──
router.get('/verify/:token', (req, res) => {
  const result = getStmts().updateVerified.run(req.params.token);
  if (result.changes === 0)
    return res.redirect('/?error=invalid_token');
  res.redirect('/?verified=1');
});

// ── FORGOT PASSWORD ──
router.post('/forgot', async (req, res) => {
  const { email } = req.body;
  const user = getStmts().getUserByEmail.get(email);
  if (!user) return res.json({ ok: true }); // Don't reveal if email exists

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 3600000; // 1 hour
  getStmts().setResetToken.run(token, expires, user.id);
  sendResetEmail(email, user.username, token).catch(console.error);

  res.json({ ok: true, message: 'If that email exists, a reset link was sent.' });
});

// ── RESET PASSWORD ──
router.get('/reset/:token', (req, res) => {
  res.sendFile('reset.html', { root: './public' });
});

router.post('/reset', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8)
    return res.json({ ok: false, error: 'Invalid request' });

  // Find user by token
  const user = require('./db').db.prepare(
    'SELECT * FROM users WHERE reset_token=? AND reset_expires > ?'
  ).get(token, Date.now());

  if (!user) return res.json({ ok: false, error: 'Token expired or invalid' });

  const hash = await bcrypt.hash(password, 12);
  getStmts().updatePassword.run(hash, user.id);

  res.json({ ok: true, message: 'Password updated. You can now log in.' });
});

// ── DISCORD OAUTH ──
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

    // Exchange code for token
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

    // Get Discord user
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();

    // Find or create local user
    let user = getStmts().getUserByDiscord.get(discordUser.id);

    if (!user) {
      // Generate unique username
      let baseUsername = discordUser.username.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 18);
      let username = baseUsername;
      let suffix = 1;
      while (getStmts().getUserByUsername.get(username)) {
        username = baseUsername + suffix++;
      }

      getStmts().upsertDiscord.run({
        username,
        discord_id: discordUser.id,
      });
      user = getStmts().getUserByDiscord.get(discordUser.id);
    }

    getStmts().updateLastSeen.run(user.id);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('Discord OAuth error:', err);
    res.redirect('/?error=discord_error');
  }
});

// ── LOGOUT ──
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── SESSION CHECK ──
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  const user = getStmts().getUserById.get(req.session.userId);
  if (!user) return res.json({ ok: false });
  res.json({
    ok: true,
    user: { id: user.id, username: user.username, role: user.role, balance: user.balance_sats },
  });
});

module.exports = router;
