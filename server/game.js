// server/game.js — Provably fair Slide game engine
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');

const HOUSE_EDGE = parseFloat(process.env.HOUSE_EDGE || 3) / 100;
const TICK_MS = 50;

function generateCrashPoint(seed, roundId) {
  const hash = crypto.createHmac('sha256', seed).update(roundId).digest('hex');
  const h = parseInt(hash.slice(0, 8), 16);
  const e = 2 ** 32;
  const crashFloat = Math.floor(100 * e / (h + (e * HOUSE_EDGE))) / 100;
  return Math.max(1.00, crashFloat);
}

function hashRound(seed, roundId) {
  return crypto.createHmac('sha256', seed).update(roundId).digest('hex');
}

class SlideGame {
  constructor(wss) {
    this.wss = wss;
    this.phase = 'waiting';
    this.roundId = null;
    this.crashPoint = null;
    this.currentMult = 1.00;
    this.startedAt = null;
    this.bets = new Map();
    this.tickInterval = null;
    this.waitTimeout = null;
    this.recentRounds = [];

    // Delay start until next tick so DB is ready
    setTimeout(() => {
      this.loadRecentRounds();
      this.scheduleNextRound(3000);
    }, 100);
  }

  loadRecentRounds() {
    try {
      const { stmts } = getDb();
      const rows = stmts.lastRounds.all(20);
      this.recentRounds = rows.map(r => ({
        roundId: r.round_id,
        crashPoint: r.crash_point / 100,
        hash: r.hash,
      })).reverse();
    } catch(e) {
      this.recentRounds = [];
    }
  }

  scheduleNextRound(delay = 7000) {
    this.phase = 'waiting';
    this.bets.clear();
    this.currentMult = 1.00;
    this.broadcast({ type: 'phase', phase: 'waiting', countdown: Math.floor(delay / 1000) });
    this.waitTimeout = setTimeout(() => this.startBetting(), delay - 5000);
  }

  startBetting() {
    this.phase = 'betting';
    const seed = crypto.randomBytes(32).toString('hex');
    this.roundId = uuidv4();
    this.crashPoint = generateCrashPoint(seed, this.roundId);
    const hash = hashRound(seed, this.roundId);

    const { stmts } = getDb();
    stmts.createRound.run({ round_id: this.roundId, crash_point: Math.round(this.crashPoint * 100), hash, seed });

    this.broadcast({ type: 'phase', phase: 'betting', roundId: this.roundId, hash, countdown: 5 });
    setTimeout(() => this.startRound(), 5000);
  }

  startRound() {
    if (this.phase !== 'betting') return;
    this.phase = 'running';
    this.startedAt = Date.now();
    const { stmts } = getDb();
    stmts.startRound.run(this.roundId);
    this.broadcast({ type: 'phase', phase: 'running', roundId: this.roundId, bets: this.getPublicBets() });
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    this.currentMult = Math.floor(100 * Math.pow(Math.E, 0.00006 * (Date.now() - this.startedAt))) / 100;
    this.currentMult = Math.max(1.00, this.currentMult);

    for (const [userId, bet] of this.bets.entries()) {
      if (!bet.cashedOut && bet.autoCashout && this.currentMult >= bet.autoCashout) {
        this.processCashout(userId, this.currentMult);
      }
    }

    this.broadcast({ type: 'mult', mult: this.currentMult });

    if (this.currentMult >= this.crashPoint) {
      this.crash();
    }
  }

  crash() {
    clearInterval(this.tickInterval);
    this.phase = 'crashed';

    const { stmts } = getDb();
    stmts.endRound.run(this.roundId);
    const roundRow = stmts.getRound.get(this.roundId);

    this.recentRounds.push({ roundId: this.roundId, crashPoint: this.crashPoint, hash: roundRow?.hash });
    if (this.recentRounds.length > 20) this.recentRounds.shift();

    const busted = [];
    for (const [userId, bet] of this.bets.entries()) {
      if (!bet.cashedOut) busted.push({ userId, username: bet.username });
    }

    this.broadcast({
      type: 'crashed',
      crashPoint: this.crashPoint,
      roundId: this.roundId,
      seed: roundRow?.seed,
      hash: roundRow?.hash,
      busted,
      recentRounds: this.recentRounds.slice(-10),
    });

    this.scheduleNextRound(7000);
  }

  placeBet(userId, username, role, amountSats, autoCashoutMult) {
    if (this.phase !== 'betting') return { ok: false, error: 'Betting phase is over' };
    if (this.bets.has(userId)) return { ok: false, error: 'Already bet this round' };

    const { stmts } = getDb();
    const userBal = stmts.getBalance.get(userId);
    if (!userBal || userBal.balance_sats < amountSats) return { ok: false, error: 'Insufficient balance' };

    stmts.updateBalance.run(-amountSats, userId);
    stmts.placeBet.run({
      round_id: this.roundId,
      user_id: userId,
      amount_sats: amountSats,
      auto_cashout: autoCashoutMult ? Math.round(autoCashoutMult * 100) : null,
    });

    this.bets.set(userId, { amountSats, autoCashout: autoCashoutMult || null, cashedOut: false, username, role });

    this.broadcast({ type: 'betPlaced', username, role, amountSats, roundId: this.roundId });

    return { ok: true, balance: userBal.balance_sats - amountSats };
  }

  cashout(userId) {
    if (this.phase !== 'running') return { ok: false, error: 'Game not running' };
    const bet = this.bets.get(userId);
    if (!bet) return { ok: false, error: 'No active bet' };
    if (bet.cashedOut) return { ok: false, error: 'Already cashed out' };
    return this.processCashout(userId, this.currentMult);
  }

  processCashout(userId, mult) {
    const bet = this.bets.get(userId);
    if (!bet || bet.cashedOut) return { ok: false };
    bet.cashedOut = true;

    const multInt = Math.round(mult * 100);
    const payoutSats = Math.floor(bet.amountSats * mult);

    const { stmts } = getDb();
    stmts.cashoutBet.run(multInt, payoutSats, this.roundId, userId);
    stmts.updateBalance.run(payoutSats, userId);

    const newBal = stmts.getBalance.get(userId);
    this.broadcast({ type: 'cashout', username: bet.username, mult, payoutSats, roundId: this.roundId });
    return { ok: true, mult, payoutSats, balance: newBal?.balance_sats };
  }

  getPublicBets() {
    return Array.from(this.bets.entries()).map(([uid, bet]) => ({
      username: bet.username, role: bet.role, amountSats: bet.amountSats, cashedOut: bet.cashedOut,
    }));
  }

  getState() {
    return { phase: this.phase, roundId: this.roundId, currentMult: this.currentMult, bets: this.getPublicBets(), recentRounds: this.recentRounds.slice(-10) };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    this.wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
  }
}

module.exports = { SlideGame };