'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const CFG = require('./config');
const Players = require('./players');
const Engine = require('./engine');
const attachBots = require('./bots');

const app = express();
// hosting platforms (Render/Fly/etc.) sit behind a proxy — trust it for real client IPs
app.set('trust proxy', 1);

// health check for the platform's uptime probe (keeps the service marked healthy)
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// lightweight ops stats — handy for monitoring and the load test
app.get('/stats', (_req, res) => {
    const m = process.memoryUsage();
    res.json({
        uptime: Math.round(process.uptime()),
        rssMB: +(m.rss / 1048576).toFixed(1),
        connections: io ? io.engine.clientsCount : 0,
        players: players.map.size,
        round: engine.round.id,
        phase: engine.round.phase,
    });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    // CORS_ORIGIN can lock this to your domain in production; '*' is fine for an open demo
    cors: { origin: process.env.CORS_ORIGIN || '*' },
    // at a 10Hz broadcast to many clients, compression costs more CPU than it saves
    perMessageDeflate: false,
});

const players = new Players();
const engine = new Engine(players);

/* ---------- relay engine events to all clients ---------- */

engine.on('state', s => io.emit('state', s));
engine.on('phase', p => io.emit('phase', p));
engine.on('bet', b => io.emit('feed:bet', b));
engine.on('whale', w => io.emit('whale', w));
engine.on('chat', c => io.emit('chat', c));
engine.on('round', id => io.emit('round:new', { round: id }));

// settlement: each socket gets its own personalized result
engine.on('settled', ({ winner, finalMult, red, blue, results }) => {
    for (const [, sock] of io.sockets.sockets) {
        const token = sock.data.token;
        const result = (token && results.get(token)) || { kind: 'spectator' };
        const payload = { winner, finalMult, red, blue, result };
        if (token && results.has(token)) {
            payload.balance = players.get(token).balance;
        }
        sock.emit('round:end', payload);
    }
    // balances just changed — refresh the leaderboard for everyone
    io.emit('leaderboard', players.getLeaderboard(10));
});

/* ---------- socket handlers ---------- */

const emitOnline = () => io.emit('online', io.engine.clientsCount);

io.on('connection', (socket) => {
    emitOnline();

    socket.emit('hello', {
        edge: CFG.HOUSE_EDGE,
        whaleMin: CFG.WHALE_MIN,
        betSecs: CFG.BET_SECS,
        liveSecs: CFG.LIVE_SECS,
        settleSecs: CFG.SETTLE_SECS,
        minBet: CFG.MIN_BET,
        maxBet: CFG.MAX_BET,
        state: engine.snapshot(),
    });
    socket.emit('leaderboard', players.getLeaderboard(10));

    socket.on('auth', (data, ack) => {
        if (typeof ack !== 'function') return;
        let { token, name } = data || {};
        name = String(name || '').trim().slice(0, 16).replace(/[^\w\- ]/g, '');
        if (!name) name = 'Player' + Math.floor(100 + Math.random() * 900);
        if (!token || typeof token !== 'string' || !players.get(token)) {
            token = crypto.randomUUID();
        }
        const p = players.getOrCreate(token, name);
        p.name = name;
        players.save();
        socket.data.token = token;

        const position = engine.positions.get(token) || null;
        ack({ ok: true, token, name: p.name, balance: p.balance, position });
        engine.systemChat(`${p.name} entered the arena.`);
    });

    const authed = (ack) => {
        if (!socket.data.token) {
            if (typeof ack === 'function') ack({ error: 'Enter a name to play' });
            return false;
        }
        return true;
    };

    socket.on('bet', (data, ack) => {
        if (!authed(ack)) return;
        const { team, amount } = data || {};
        const res = engine.placeBet(socket.data.token, team, amount);
        if (typeof ack === 'function') ack(res);
    });

    socket.on('boost', (data, ack) => {
        if (!authed(ack)) return;
        const res = engine.boost(socket.data.token, (data || {}).amount);
        if (typeof ack === 'function') ack(res);
    });

    socket.on('cancel', (_data, ack) => {
        if (!authed(ack)) return;
        const res = engine.cancelBet(socket.data.token);
        if (typeof ack === 'function') ack(res);
    });

    socket.on('refill', (_data, ack) => {
        if (!authed(ack)) return;
        const p = players.get(socket.data.token);
        if (p.balance >= CFG.REFILL_BELOW) {
            if (typeof ack === 'function') ack({ error: `Refill only available under $${CFG.REFILL_BELOW}` });
            return;
        }
        const balance = players.credit(socket.data.token, CFG.REFILL_AMOUNT);
        if (typeof ack === 'function') ack({ ok: true, balance });
    });

    let lastChat = 0;
    socket.on('chat', (data) => {
        if (!socket.data.token) return;
        const now = Date.now();
        if (now - lastChat < 800) return; // rate limit
        lastChat = now;
        const text = String((data || {}).text || '').trim().slice(0, 140);
        if (!text) return;
        const p = players.get(socket.data.token);
        const pos = engine.positions.get(socket.data.token);
        io.emit('chat', { name: p.name, team: pos ? pos.team : null, text, system: false });
    });

    socket.on('disconnect', emitOnline);
});

/* ---------- boot ---------- */

(async () => {
    await players.init();                    // load balances before accepting players
    console.log(`[players] storage backend: ${players.backend}`);

    engine.start();
    if (CFG.BOTS) {
        attachBots(engine);
        console.log('[bots] simulated liquidity enabled (set BOTS=0 to disable)');
    }

    // keep the leaderboard fresh even between settlements
    setInterval(() => io.emit('leaderboard', players.getLeaderboard(10)), 5000);

    server.listen(CFG.PORT, () => {
        console.log(`🐋 Whale Wars running at http://localhost:${CFG.PORT}`);
    });
})();
