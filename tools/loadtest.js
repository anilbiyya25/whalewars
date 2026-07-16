'use strict';

/**
 * Whale Wars load test — simulates many concurrent players against a running
 * server and measures connection success, action-ack latency, and server memory.
 *
 * Usage:
 *   node tools/loadtest.js [count] [url] [durationSec]
 *   node tools/loadtest.js 300 http://localhost:3000 25
 */

const { io } = require('socket.io-client');

const COUNT = parseInt(process.argv[2] || '300', 10);
const URL = process.argv[3] || 'http://localhost:3000';
const DURATION = parseInt(process.argv[4] || '25', 10) * 1000;
const RAMP_MS = 8;                 // stagger connects so we don't thundering-herd

const stats = {
    connected: 0, failed: 0, disconnects: 0,
    bets: 0, boosts: 0, cashouts: 0, rejects: 0,
    latencies: [],
};

const sockets = [];
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

function spawn(i) {
    const sock = io(URL, { transports: ['websocket'], reconnection: false, timeout: 8000 });
    sockets.push(sock);
    let balance = 0, hasPosition = false;

    sock.on('connect', () => {
        stats.connected++;
        sock.emit('auth', { name: 'Bot' + i }, res => {
            if (res && res.ok) balance = res.balance;
        });
    });
    sock.on('connect_error', () => { stats.failed++; });
    sock.on('disconnect', () => { stats.disconnects++; });

    // react to phase: bet in betting, sometimes boost/cashout in live
    sock.on('state', s => {
        if (Math.random() > 0.04) return;              // throttle each bot's actions
        if (s.phase === 'betting' && !hasPosition && balance > 100) {
            const t0 = Date.now();
            sock.emit('bet', { team: pick(['red', 'blue']), amount: Math.floor(rand(50, 800)) }, res => {
                stats.latencies.push(Date.now() - t0);
                if (res && res.ok) { hasPosition = true; balance = res.balance; stats.bets++; }
                else stats.rejects++;
            });
        } else if (s.phase === 'live' && hasPosition) {
            if (Math.random() < 0.3) {
                const t0 = Date.now();
                sock.emit('cashout', {}, res => {
                    stats.latencies.push(Date.now() - t0);
                    if (res && res.ok) { hasPosition = false; balance = res.balance; stats.cashouts++; }
                    else stats.rejects++;
                });
            }
        }
    });
    sock.on('round:new', () => { hasPosition = false; });
    sock.on('round:end', d => { if (typeof d.balance === 'number') balance = d.balance; hasPosition = false; });
}

async function pollStats() {
    try {
        const r = await fetch(URL + '/stats');
        return await r.json();
    } catch { return null; }
}

function pct(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];
}

(async () => {
    console.log(`\nLoad test: ${COUNT} clients -> ${URL} for ${DURATION / 1000}s\n`);
    const before = await pollStats();
    if (before) console.log(`server before: ${before.rssMB}MB rss, ${before.connections} connections\n`);

    for (let i = 0; i < COUNT; i++) { spawn(i); await new Promise(r => setTimeout(r, RAMP_MS)); }
    console.log(`ramp complete: ${stats.connected}/${COUNT} connected, ${stats.failed} failed\n`);

    const t = setInterval(async () => {
        const s = await pollStats();
        if (s) console.log(`  live: ${s.connections} conns | ${s.rssMB}MB rss | round ${s.round}/${s.phase} | bets ${stats.bets} cashouts ${stats.cashouts} rejects ${stats.rejects}`);
    }, 3000);

    await new Promise(r => setTimeout(r, DURATION));
    clearInterval(t);

    const after = await pollStats();
    console.log('\n================ RESULTS ================');
    console.log(`clients connected : ${stats.connected}/${COUNT}  (failed ${stats.failed}, disconnects ${stats.disconnects})`);
    console.log(`actions           : ${stats.bets} bets, ${stats.cashouts} cashouts, ${stats.rejects} rejects`);
    console.log(`ack latency (ms)  : p50 ${pct(stats.latencies, 50)} | p95 ${pct(stats.latencies, 95)} | p99 ${pct(stats.latencies, 99)} | max ${Math.max(0, ...stats.latencies)}`);
    if (after) console.log(`server after      : ${after.rssMB}MB rss, ${after.connections} connections`);
    console.log('=========================================\n');

    sockets.forEach(s => s.close());
    process.exit(0);
})();
