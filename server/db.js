// server/db.js — SQLite via sql.js (pure JavaScript, no build tools needed)
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const dbDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'vaultbet.db');

let _cache = null;

async function initDb() {
  if (_cache) return _cache;

  const SQL = await initSqlJs();
  const db = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();

  function save() {
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password TEXT,
      discord_id TEXT UNIQUE,
      role TEXT DEFAULT 'user',
      balance_sats INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      verify_token TEXT,
      reset_token TEXT,
      reset_expires INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      last_seen INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS game_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT UNIQUE NOT NULL,
      crash_point INTEGER NOT NULL,
      hash TEXT NOT NULL,
      seed TEXT NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      amount_sats INTEGER NOT NULL,
      cashout_mult INTEGER,
      payout_sats INTEGER DEFAULT 0,
      auto_cashout INTEGER,
      placed_at INTEGER DEFAULT (strftime('%s','now')),
      cashed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user INTEGER NOT NULL,
      to_user INTEGER NOT NULL,
      amount_sats INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      coin TEXT NOT NULL,
      address TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  save();

  function dbRun(sql, params = []) {
    db.run(sql, params);
    save();
    return { changes: db.getRowsModified() };
  }

  function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  function dbAll(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function lastId() { return dbGet('SELECT last_insert_rowid() as id')?.id; }

  const stmts = {
    createUser: { run: (p) => { dbRun('INSERT INTO users (username,email,password,verify_token,verified) VALUES (?,?,?,?,?)', [p.username,p.email||null,p.password||null,p.verify_token||null,p.verified]); return lastId(); } },
    getUserById:       { get: (id) => dbGet('SELECT * FROM users WHERE id=?',[id]) },
    getUserByEmail:    { get: (e)  => dbGet('SELECT * FROM users WHERE lower(email)=lower(?)',[e]) },
    getUserByUsername: { get: (u)  => dbGet('SELECT * FROM users WHERE lower(username)=lower(?)',[u]) },
    getUserByDiscord:  { get: (id) => dbGet('SELECT * FROM users WHERE discord_id=?',[id]) },
    updateVerified:    { run: (t)  => dbRun('UPDATE users SET verified=1,verify_token=NULL WHERE verify_token=?',[t]) },
    updatePassword:    { run: (h,id) => dbRun('UPDATE users SET password=?,reset_token=NULL,reset_expires=NULL WHERE id=?',[h,id]) },
    setResetToken:     { run: (t,e,id) => dbRun('UPDATE users SET reset_token=?,reset_expires=? WHERE id=?',[t,e,id]) },
    updateLastSeen:    { run: (id) => dbRun("UPDATE users SET last_seen=strftime('%s','now') WHERE id=?",[id]) },
    updateBalance:     { run: (d,id) => dbRun('UPDATE users SET balance_sats=balance_sats+? WHERE id=?',[d,id]) },
    getBalance:        { get: (id) => dbGet('SELECT balance_sats FROM users WHERE id=?',[id]) },
    upsertDiscord: {
      run: (p) => {
        if (dbGet('SELECT id FROM users WHERE discord_id=?',[p.discord_id])) {
          dbRun("UPDATE users SET last_seen=strftime('%s','now') WHERE discord_id=?",[p.discord_id]);
        } else {
          dbRun("INSERT INTO users (username,discord_id,verified,role) VALUES (?,?,1,'user')",[p.username,p.discord_id]);
        }
      }
    },
    createRound: { run: (p) => dbRun('INSERT INTO game_rounds (round_id,crash_point,hash,seed) VALUES (?,?,?,?)',[p.round_id,p.crash_point,p.hash,p.seed]) },
    startRound:  { run: (id) => dbRun("UPDATE game_rounds SET started_at=strftime('%s','now') WHERE round_id=?",[id]) },
    endRound:    { run: (id) => dbRun("UPDATE game_rounds SET ended_at=strftime('%s','now') WHERE round_id=?",[id]) },
    getRound:    { get: (id) => dbGet('SELECT * FROM game_rounds WHERE round_id=?',[id]) },
    lastRounds:  { all: (n)  => dbAll('SELECT * FROM game_rounds WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT ?',[n]) },
    placeBet:    { run: (p)  => dbRun('INSERT INTO bets (round_id,user_id,amount_sats,auto_cashout) VALUES (?,?,?,?)',[p.round_id,p.user_id,p.amount_sats,p.auto_cashout||null]) },
    cashoutBet:  { run: (m,ps,rid,uid) => dbRun("UPDATE bets SET cashout_mult=?,payout_sats=?,cashed_at=strftime('%s','now') WHERE round_id=? AND user_id=? AND cashout_mult IS NULL",[m,ps,rid,uid]) },
    getRoundBets:{ all: (rid) => dbAll('SELECT b.*,u.username,u.role FROM bets b JOIN users u ON b.user_id=u.id WHERE b.round_id=?',[rid]) },
    getUserBets: { all: (uid,lim) => dbAll('SELECT * FROM bets WHERE user_id=? ORDER BY id DESC LIMIT ?',[uid,lim]) },
    hasBetInRound:{ get: (rid,uid) => dbGet('SELECT id FROM bets WHERE round_id=? AND user_id=?',[rid,uid]) },
    saveMessage: { run: (uid,msg) => dbRun('INSERT INTO chat_messages (user_id,message) VALUES (?,?)',[uid,msg]) },
    recentChat:  { all: () => dbAll('SELECT cm.*,u.username,u.role FROM chat_messages cm JOIN users u ON cm.user_id=u.id ORDER BY cm.id DESC LIMIT 50') },
    createTip:   { run: (f,t,a) => dbRun('INSERT INTO tips (from_user,to_user,amount_sats) VALUES (?,?,?)',[f,t,a]) },
    createDeposit:{ run: (uid,coin,addr) => dbRun('INSERT INTO deposits (user_id,coin,address) VALUES (?,?,?)',[uid,coin,addr]) },
    userStats:   { get: (uid) => dbGet('SELECT COUNT(*) as total_bets, SUM(CASE WHEN cashout_mult IS NOT NULL THEN 1 ELSE 0 END) as wins, SUM(amount_sats) as wagered, SUM(payout_sats)-SUM(amount_sats) as profit FROM bets WHERE user_id=?',[uid]) },
    leaderboard: { all: () => dbAll('SELECT u.username,u.role,SUM(b.amount_sats) as wagered,SUM(b.payout_sats)-SUM(b.amount_sats) as profit,COUNT(*) as bets FROM bets b JOIN users u ON b.user_id=u.id GROUP BY u.id ORDER BY profit DESC LIMIT 50') },
  };

  _cache = { stmts, run: dbRun, get: dbGet, all: dbAll, save };
  return _cache;
}

function getDb() {
  if (!_cache) throw new Error('DB not ready — await initDb() first');
  return _cache;
}

module.exports = { initDb, getDb };
