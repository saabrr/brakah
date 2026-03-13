const { getDb } = require('./db');

const RATE_LIMITS = {
  chat: { max: 5, window: 5000 },
  bet: { max: 1, window: 1000 },
  cashout: { max: 1, window: 500 },
  tip: { max: 3, window: 10000 },
};

function checkRate(client, action) {
  if (!client.rates) client.rates = {};
  const now = Date.now();
  const rl = RATE_LIMITS[action];
  if (!rl) return true;
  if (!client.rates[action]) client.rates[action] = { count: 0, reset: now + rl.window };
  if (now > client.rates[action].reset) client.rates[action] = { count: 0, reset: now + rl.window };
  if (client.rates[action].count >= rl.max) return false;
  client.rates[action].count++;
  return true;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function setupWebSocket(wss, game) {
  wss.on('connection', (ws, req) => {
    ws.userId = null;
    ws.user = null;
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    send(ws, { type: 'init', state: game.getState() });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      const { type } = msg;
      const stmts = getDb().stmts;

      if (type === 'auth') {
        if (msg.userId && msg.username) {
          ws.userId = msg.userId;
          ws.user = { id: msg.userId, username: msg.username, role: msg.role };

          const history = stmts.recentChat.all().reverse();
          send(ws, { type: 'chatHistory', messages: history.map(m => ({
            username: m.username, role: m.role, message: m.message, time: m.created_at,
          }))});

          send(ws, { type: 'stats', stats: stmts.userStats.get(ws.userId) });
          send(ws, { type: 'balance', balance: stmts.getBalance.get(ws.userId)?.balance_sats || 0 });
        }
        return;
      }

      if (!ws.userId) return send(ws, { type: 'error', message: 'Not authenticated' });

      if (type === 'bet') {
        if (!checkRate(ws, 'bet')) return send(ws, { type: 'error', message: 'Too fast!' });
        const amountSats = Math.round(parseFloat(msg.amount) * 100);
        const autoCashout = parseFloat(msg.autoCashout) || null;
        if (!amountSats || amountSats < 1) return send(ws, { type: 'error', message: 'Invalid bet amount' });
        const result = game.placeBet(ws.userId, ws.user.username, ws.user.role, amountSats, autoCashout);
        if (!result.ok) return send(ws, { type: 'error', message: result.error });
        send(ws, { type: 'betOk', balance: result.balance });
        return;
      }

      if (type === 'cashout') {
        if (!checkRate(ws, 'cashout')) return;
        const result = game.cashout(ws.userId);
        if (!result.ok) return send(ws, { type: 'error', message: result.error });
        send(ws, { type: 'cashoutOk', mult: result.mult, payoutSats: result.payoutSats, balance: result.balance });
        send(ws, { type: 'stats', stats: stmts.userStats.get(ws.userId) });
        return;
      }

      if (type === 'chat') {
        if (!checkRate(ws, 'chat')) return send(ws, { type: 'error', message: 'Slow down!' });
        const message = (msg.message || '').trim().slice(0, 200);
        if (!message) return;
        stmts.saveMessage.run(ws.userId, message);
        const chatMsg = { type: 'chat', username: ws.user.username, role: ws.user.role, message, time: Math.floor(Date.now() / 1000) };
        wss.clients.forEach(client => { if (client.readyState === 1) send(client, chatMsg); });
        return;
      }

      if (type === 'tip') {
        if (!checkRate(ws, 'tip')) return send(ws, { type: 'error', message: 'Too many tips!' });
        const { toUsername, amountSats } = msg;
        const amt = parseInt(amountSats);
        if (!amt || amt < 1) return send(ws, { type: 'error', message: 'Invalid tip amount' });
        const toUser = stmts.getUserByUsername.get(toUsername);
        if (!toUser) return send(ws, { type: 'error', message: 'User not found' });
        if (toUser.id === ws.userId) return send(ws, { type: 'error', message: "Can't tip yourself" });
        const myBal = stmts.getBalance.get(ws.userId);
        if (!myBal || myBal.balance_sats < amt) return send(ws, { type: 'error', message: 'Insufficient balance' });
        stmts.updateBalance.run(-amt, ws.userId);
        stmts.updateBalance.run(amt, toUser.id);
        stmts.createTip.run(ws.userId, toUser.id, amt);
        const newBal = stmts.getBalance.get(ws.userId);
        send(ws, { type: 'tipOk', balance: newBal.balance_sats });
        wss.clients.forEach(client => {
          if (client.readyState === 1 && client.userId === toUser.id) {
            const recvBal = stmts.getBalance.get(toUser.id);
            send(client, { type: 'tipReceived', from: ws.user.username, amountSats: amt, balance: recvBal.balance_sats });
          }
        });
        const tipMsg = { type: 'chat', username: 'System', role: 'system', message: `🌧 ${ws.user.username} tipped ${toUser.username} $${(amt/100).toFixed(2)}!`, time: Math.floor(Date.now()/1000) };
        wss.clients.forEach(client => { if (client.readyState === 1) send(client, tipMsg); });
        return;
      }

      if (type === 'rain') {
        if (!checkRate(ws, 'tip')) return send(ws, { type: 'error', message: 'Too fast!' });
        const totalSats = parseInt(msg.totalSats);
        if (!totalSats || totalSats < 100) return send(ws, { type: 'error', message: 'Min rain is $1' });
        const myBal = stmts.getBalance.get(ws.userId);
        if (!myBal || myBal.balance_sats < totalSats) return send(ws, { type: 'error', message: 'Insufficient balance' });
        const onlineUsers = [];
        wss.clients.forEach(client => { if (client.readyState === 1 && client.userId && client.userId !== ws.userId) onlineUsers.push(client); });
        if (onlineUsers.length === 0) return send(ws, { type: 'error', message: 'No users online!' });
        const perUser = Math.floor(totalSats / onlineUsers.length);
        if (perUser < 1) return send(ws, { type: 'error', message: 'Amount too small to rain' });
        const actualTotal = perUser * onlineUsers.length;
        stmts.updateBalance.run(-actualTotal, ws.userId);
        onlineUsers.forEach(client => {
          stmts.updateBalance.run(perUser, client.userId);
          const newBal = stmts.getBalance.get(client.userId);
          send(client, { type: 'rainReceived', from: ws.user.username, amountSats: perUser, balance: newBal?.balance_sats });
        });
        send(ws, { type: 'rainOk', balance: stmts.getBalance.get(ws.userId).balance_sats, recipients: onlineUsers.length });
        const rainMsg = { type: 'chat', username: 'System', role: 'system', message: `🌧 ${ws.user.username} rained $${(actualTotal/100).toFixed(2)} on ${onlineUsers.length} users!`, time: Math.floor(Date.now()/1000) };
        wss.clients.forEach(client => { if (client.readyState === 1) send(client, rainMsg); });
        return;
      }

if (type === 'adminBalance') {
  if (!ws.user || ws.user.role !== 'owner') return send(ws, { type: 'error', message: 'No permission' });
  const { targetUsername, amount } = msg;
  const target = stmts.getUserByUsername.get(targetUsername);
  if (!target) return send(ws, { type: 'error', message: 'User not found' });
  const cents = Math.round(parseFloat(amount) * 100);
  stmts.updateBalance.run(cents, target.id);
  const newBal = stmts.getBalance.get(target.id);
  send(ws, { type: 'balance', balance: newBal.balance_sats });
  send(ws, { type: 'chat', username: 'System', role: 'system', message: `💰 $${(cents/100).toFixed(2)} added!`, time: Math.floor(Date.now()/1000) });
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.userId === target.id) {
      send(client, { type: 'balance', balance: newBal.balance_sats });
    }
  });
  return;
}

      if (type === 'getStats') {
        send(ws, { type: 'stats', stats: stmts.userStats.get(ws.userId) });
        return;
      }
    });

    ws.on('close', () => broadcastOnlineCount(wss));
    ws.on('error', console.error);
    broadcastOnlineCount(wss);
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
    broadcastOnlineCount(wss);
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));
}

function broadcastOnlineCount(wss) {
  let count = 0;
  wss.clients.forEach(c => { if (c.readyState === 1) count++; });
  const msg = JSON.stringify({ type: 'online', count });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

module.exports = { setupWebSocket };