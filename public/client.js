'use strict';

/* =====================================================
   Whale Wars client — renders server state, sends intents.
   No game math lives here; the server is authoritative.
   ===================================================== */

const socket = io();

let CFGC = { edge: 0.035, whaleMin: 5000, betSecs: 10, liveSecs: 35, settleSecs: 6, minBet: 10, maxBet: 100000 };
let ST = null;                 // latest server snapshot
let prevPhase = null;
let me = { name: null, token: null, balance: 0, position: null };
let history = [];
let soundOn = true;

/* ================= DOM ================= */
const $ = id => document.getElementById(id);
const el = {
    modal: $('name-modal'), nameInput: $('name-input'),
    conn: $('conn-banner'), toast: $('toast'),
    balance: $('user-balance'), online: $('online-count'), refill: $('refill-btn'),
    roundNum: $('round-num'), history: $('history-chips'),
    arena: $('arena'), canvas: $('arena-canvas'),
    timerText: $('timer-text'), timerPhase: $('timer-phase'), timerRing: $('timer-ring'),
    whaleBanner: $('whale-banner'), floaters: $('floaters'),
    redHud: $('red-hud'), blueHud: $('blue-hud'),
    redMult: $('red-mult'), blueMult: $('blue-mult'),
    redPool: $('red-pool'), bluePool: $('blue-pool'),
    redBettors: $('red-bettors'), blueBettors: $('blue-bettors'),
    betInput: $('bet-amount'), betRow: $('bet-input-row'), edgeNote: $('edge-note'),
    joinRed: $('join-red'), joinBlue: $('join-blue'),
    posCard: $('position-card'), posTeam: $('pos-team'), posStake: $('pos-stake'),
    posValue: $('pos-value'), posProfit: $('pos-profit'),
    boostBtn: $('boost-btn'), boostLabel: $('boost-label'),
    cashBtn: $('cashout-btn'), cashVal: $('cashout-val'),
    spectate: $('spectate-note'),
    overlay: $('result-overlay'), ovTitle: $('ov-title'), ovSub: $('ov-sub'),
    ovOutcome: $('ov-outcome'), ovCount: $('ov-count'),
    chatBox: $('chat-box'), betsBox: $('bets-box'), leadersBox: $('leaders-box'), chatInput: $('chat-input'),
    confetti: $('confetti-layer'), soundBtn: $('sound-btn'),
};

/* ================= UTILS ================= */
const fmtC = n => '🪙' + Math.round(n).toLocaleString('en-US');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const TAU = Math.PI * 2;

let toastTimer = null;
function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

/* ================= AUDIO ================= */
let AC = null;
function audioCtx() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    return AC;
}
function blip(freq, dur, type = 'sine', gain = 0.08, when = 0) {
    if (!soundOn) return;
    const ctx = audioCtx(); if (!ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + dur);
}
const snd = {
    tick:    () => blip(1250, 0.06, 'square', 0.04),
    join:    () => { blip(520, 0.1); blip(780, 0.12, 'sine', 0.08, 0.08); },
    boost:   () => { blip(300, 0.15, 'sawtooth', 0.06); blip(600, 0.1, 'sine', 0.06, 0.05); },
    whale:   () => { blip(110, 0.5, 'sawtooth', 0.1); blip(165, 0.4, 'sawtooth', 0.07, 0.1); },
    cashout: () => { blip(660, 0.12); blip(880, 0.14, 'sine', 0.09, 0.1); blip(1320, 0.2, 'sine', 0.08, 0.2); },
    win:     () => [523, 659, 784, 1047].forEach((f, i) => blip(f, 0.25, 'sine', 0.09, i * 0.12)),
    lose:    () => [400, 300, 200].forEach((f, i) => blip(f, 0.3, 'sawtooth', 0.05, i * 0.15)),
};
function toggleSound() {
    soundOn = !soundOn;
    el.soundBtn.textContent = soundOn ? '🔊' : '🔇';
}
document.addEventListener('pointerdown', () => {
    const c = audioCtx();
    if (c && c.state === 'suspended') c.resume();
}, { once: true });

/* =====================================================================
   WHALE ARENA CANVAS
   Two whales tug a golden chest across a stormy sea. The scene is a pure
   view of server state: SIM mirrors the latest snapshot (ST), the rope
   position is smoothed between the 10Hz updates, and socket events fire
   the coin splashes, whale roars and celebrations.
   ===================================================================== */
const cv = el.canvas;
const cx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resizeCanvas() {
    const r = cv.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    cv.width = W * DPR; cv.height = H * DPR;
    cx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
new ResizeObserver(resizeCanvas).observe(cv);
resizeCanvas();

// local mirror of server state, with a smoothed rope position
const SIM = { phase: 'betting', pos: 50, red: 0, blue: 0, rMult: 1, bMult: 1, winner: null };
function syncSIM(dt) {
    const s = ST || SIM;
    SIM.phase = s.phase; SIM.red = s.red; SIM.blue = s.blue;
    SIM.rMult = s.rMult; SIM.bMult = s.bMult;
    SIM.winner = s.phase === 'settled' ? s.winner : null;
    SIM.pos += (s.pos - SIM.pos) * Math.min(1, dt * 12); // smooth 10Hz → 60fps
}

/* ---- extra sound effects for the scene ---- */
const sndSplash = () => { blip(500, 0.08, 'sine', 0.05); blip(340, 0.12, 'sine', 0.04, 0.03); };
const sndHorn = () => { blip(98, 0.7, 'sawtooth', 0.12); blip(147, 0.55, 'sawtooth', 0.08, 0.08); blip(196, 0.4, 'sine', 0.06, 0.16); };

/* ---- scene state ---- */
let T = 0, shake = 0, lightning = 0, prevRM = 1, prevBM = 1;
// view scale: shrink the art on narrow screens so the two whales don't overlap.
// 1.0 on desktop-width canvases, ~0.5 on a phone.
let VS = 1;
function newWhale(ph) {
    return { lean: 0, recoil: 0, sink: 0, pulse: 0, blink: 0, nextBlink: rand(1.5, 4),
             roar: 0, heavePh: ph, airborne: false, sx: -9999, sy: -9999, srad: 95 };
}
const whaleR = newWhale(0), whaleB = newWhale(2.2);
const MOUSE = { x: -9999, y: -9999 };

const particles = [];
const bubbles = [];
for (let i = 0; i < 40; i++) bubbles.push({ x: Math.random(), y: Math.random(), r: rand(1, 3.5), s: rand(6, 20) });
const stars = [];
for (let i = 0; i < 90; i++) stars.push({ x: Math.random(), y: Math.random() * 0.32, r: rand(0.4, 1.4), tw: rand(0, TAU) });

/* fish armies — one fish per fighter, capped */
const fishR = [], fishB = [];
function newFish() { return { ox: rand(30, 190), oy: rand(-38, 74), ph: rand(0, TAU), sp: rand(0.8, 1.6), s: rand(5, 11) }; }
function syncFish() {
    const rn = ST ? ST.redBettors : 0, bn = ST ? ST.blueBettors : 0;
    while (fishR.length < Math.min(rn, 30)) fishR.push(newFish());
    while (fishB.length < Math.min(bn, 30)) fishB.push(newFish());
    if (rn === 0) fishR.length = 0;
    if (bn === 0) fishB.length = 0;
}

/* ---- geometry ---- */
const seaLevel = () => H * 0.50;
const waterY = x => seaLevel() + Math.sin(x * 0.008 + T * 1.4) * 8 + Math.sin(x * 0.017 - T * 0.9) * 4;
const trackL = () => W * 0.12, trackR = () => W * 0.88;
const posToX = p => lerp(trackL(), trackR(), p / 100);
function teamWaterX(team) {
    const mx = posToX(SIM.pos);
    return team === 'red' ? clamp(mx - W * 0.20, W * 0.05, W * 0.78) : clamp(mx + W * 0.20, W * 0.22, W * 0.95);
}

/* ---- mouse: poke a whale and it roars back ---- */
function hitWhale(x, y) {
    if (Math.hypot(x - whaleR.sx, y - whaleR.sy) < whaleR.srad) return 'red';
    if (Math.hypot(x - whaleB.sx, y - whaleB.sy) < whaleB.srad) return 'blue';
    return null;
}
function pokeWhale(team) {
    const st = team === 'red' ? whaleR : whaleB;
    st.roar = 1; st.recoil = 1;
    shake = Math.max(shake, 5);
    blip(90 + rand(0, 40), 0.5, 'sawtooth', 0.1); blip(140, 0.35, 'sawtooth', 0.06, 0.06);
    particles.push({ kind: 'text', x: st.sx, y: st.sy - 130, vx: 0, vy: -30, life: 0, maxLife: 1.3,
        size: 20, team, text: pick(['ROAAAR!', 'GRRRR!', '💢', 'WHO DARES?!', 'MY CHEST!']) });
    for (let i = 0; i < 12; i++)
        particles.push({ kind: 'spray', x: st.sx + rand(-80, 80), y: waterY(st.sx), vx: rand(-90, 90), vy: rand(-210, -60), life: 0, maxLife: 0.7, size: rand(2, 4.5) });
}
cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect();
    MOUSE.x = e.clientX - r.left; MOUSE.y = e.clientY - r.top;
    cv.style.cursor = hitWhale(MOUSE.x, MOUSE.y) ? 'pointer' : 'default';
});
cv.addEventListener('pointerdown', e => {
    const r = cv.getBoundingClientRect();
    const t = hitWhale(e.clientX - r.left, e.clientY - r.top);
    if (t) pokeWhale(t);
});

/* ---- scene effects (called from socket events) ---- */
function coinSplash(team, amt, whale) {
    const x = teamWaterX(team);
    const n = whale ? 26 : clamp(Math.round(amt / 150), 4, 14);
    for (let i = 0; i < n; i++)
        particles.push({ kind: 'coin', x: x + rand(-40, 40), y: waterY(x) - rand(120, 250),
            vx: rand(-30, 30), vy: rand(40, 130), life: 0, maxLife: rand(0.9, 1.5),
            size: whale ? rand(4, 7) : rand(2.5, 5), team });
    particles.push({ kind: 'text', x, y: waterY(x) - 140, vx: 0, vy: -32, life: 0, maxLife: 1.5,
        size: whale ? 24 : 14, team, text: (whale ? '🐋 +🪙' : '+🪙') + Math.round(amt).toLocaleString() });
    if (!whale) sndSplash();
}
function whaleEvent(team, amt) {
    sndHorn();
    shake = Math.min(16, 7 + amt / 4000);
    lightning = 1;
    const w = team === 'red' ? whaleR : whaleB;
    w.recoil = 1; w.roar = 1;
    const wx = teamWaterX(team), wy = waterY(wx);
    particles.push({ kind: 'ring', x: wx, y: wy, life: 0, maxLife: 0.9, size: 10, team });
    particles.push({ kind: 'ring', x: wx, y: wy, life: -0.15, maxLife: 0.9, size: 10, team });
}

/* ---- draw: sky ---- */
function drawSky() {
    const g = cx.createLinearGradient(0, 0, 0, seaLevel());
    if (lightning > 0.02) {
        const l = lightning * 0.5;
        g.addColorStop(0, `rgb(${30 + 160 * l},${34 + 160 * l},${60 + 150 * l})`);
        g.addColorStop(1, `rgb(${16 + 120 * l},${20 + 120 * l},${44 + 120 * l})`);
    } else { g.addColorStop(0, '#0a0e1e'); g.addColorStop(1, '#101731'); }
    cx.fillStyle = g; cx.fillRect(0, 0, W, seaLevel() + 20);

    cx.fillStyle = '#fff';
    for (const s of stars) {
        cx.globalAlpha = 0.25 + 0.55 * Math.abs(Math.sin(T * 0.8 + s.tw));
        cx.beginPath(); cx.arc(s.x * W, s.y * H, s.r, 0, TAU); cx.fill();
    }
    cx.globalAlpha = 1;

    cx.fillStyle = '#f4f0dc'; cx.shadowColor = '#f4f0dc'; cx.shadowBlur = 26;
    cx.beginPath(); cx.arc(W * 0.86, H * 0.15, 22, 0, TAU); cx.fill();
    cx.shadowBlur = 0; cx.fillStyle = '#0a0e1e';
    cx.beginPath(); cx.arc(W * 0.86 + 9, H * 0.15 - 5, 18, 0, TAU); cx.fill();

    if (lightning > 0.4) {
        const x0 = rand(W * 0.2, W * 0.8);
        cx.strokeStyle = `rgba(255,255,240,${lightning})`;
        cx.lineWidth = 2.5; cx.shadowColor = '#fff'; cx.shadowBlur = 16;
        cx.beginPath(); cx.moveTo(x0, 0);
        let y = 0, x = x0;
        while (y < seaLevel() * 0.8) { x += rand(-32, 32); y += rand(22, 50); cx.lineTo(x, y); }
        cx.stroke(); cx.shadowBlur = 0;
    }
}

/* ---- draw: sea ---- */
function drawSea() {
    const g = cx.createLinearGradient(0, seaLevel() - 20, 0, H);
    g.addColorStop(0, '#0e2140'); g.addColorStop(0.5, '#081428'); g.addColorStop(1, '#03070f');
    cx.fillStyle = g;
    cx.beginPath(); cx.moveTo(0, H); cx.lineTo(0, waterY(0));
    for (let x = 0; x <= W; x += 14) cx.lineTo(x, waterY(x));
    cx.lineTo(W, H); cx.closePath(); cx.fill();

    const mx = posToX(SIM.pos);
    const rg = cx.createRadialGradient(mx - W * 0.25, seaLevel() + 60, 10, mx - W * 0.25, seaLevel() + 60, W * 0.32);
    rg.addColorStop(0, `rgba(255,42,95,${0.10 + 0.13 * (1 - SIM.pos / 100)})`); rg.addColorStop(1, 'transparent');
    cx.fillStyle = rg; cx.fillRect(0, seaLevel() - 30, W, H);
    const bg = cx.createRadialGradient(mx + W * 0.25, seaLevel() + 60, 10, mx + W * 0.25, seaLevel() + 60, W * 0.32);
    bg.addColorStop(0, `rgba(42,134,255,${0.10 + 0.13 * (SIM.pos / 100)})`); bg.addColorStop(1, 'transparent');
    cx.fillStyle = bg; cx.fillRect(0, seaLevel() - 30, W, H);

    cx.strokeStyle = 'rgba(180,220,255,0.22)'; cx.lineWidth = 1.6;
    cx.beginPath();
    for (let x = 0; x <= W; x += 14) { const y = waterY(x); x === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y); }
    cx.stroke();

    cx.fillStyle = 'rgba(200,230,255,0.16)';
    for (const b of bubbles) {
        b.y -= b.s * 0.0006;
        if (b.y * H < seaLevel() + 20) { b.y = 1; b.x = Math.random(); }
        cx.beginPath(); cx.arc(b.x * W, b.y * H, b.r, 0, TAU); cx.fill();
    }
}

/* ---- draw: goal zones ---- */
function drawDangerZones() {
    const zr = posToX(85), zlw = posToX(15);
    const inRed = SIM.pos < 15, inBlue = SIM.pos > 85;
    const puls = 0.5 + 0.5 * Math.sin(T * 8);
    cx.fillStyle = `rgba(255,42,95,${inRed ? 0.10 + 0.10 * puls : 0.035})`;
    cx.fillRect(0, seaLevel() - 130, zlw, H);
    cx.fillStyle = `rgba(42,134,255,${inBlue ? 0.10 + 0.10 * puls : 0.035})`;
    cx.fillRect(zr, seaLevel() - 130, W - zr, H);
    for (const [x, col, active] of [[posToX(4), '255,42,95', inRed], [posToX(96), '42,134,255', inBlue]]) {
        cx.strokeStyle = `rgba(${col},${active ? 0.55 + 0.4 * puls : 0.28})`;
        cx.lineWidth = active ? 4 : 2; cx.setLineDash([10, 8]);
        cx.beginPath(); cx.moveTo(x, seaLevel() - 120); cx.lineTo(x, seaLevel() + 120); cx.stroke();
        cx.setLineDash([]);
    }
}

/* ---- draw: fish ---- */
function drawFish(arr, team) {
    const col = team === 'red' ? '#ff5c84' : '#5ca4ff';
    const wx = teamWaterX(team), dir = team === 'red' ? -1 : 1;
    for (const f of arr) {
        const s = f.s * VS;
        const fx = wx + dir * f.ox * VS;
        const fy = waterY(fx) + (44 + f.oy) * VS + Math.sin(T * 2 * f.sp + f.ph) * 5;
        const tail = Math.sin(T * 9 * f.sp + f.ph) * s * 0.5;
        cx.globalAlpha = 0.85; cx.fillStyle = col;
        cx.beginPath(); cx.ellipse(fx, fy, s, s * 0.55, 0, 0, TAU); cx.fill();
        cx.fillStyle = '#0a0e18';
        cx.beginPath(); cx.arc(fx + dir * s * 0.55, fy - s * 0.12, Math.max(1, s * 0.16), 0, TAU); cx.fill();
        cx.fillStyle = col;
        cx.beginPath();
        cx.moveTo(fx - dir * s, fy);
        cx.lineTo(fx - dir * (s + s * 0.9), fy - s * 0.55 + tail);
        cx.lineTo(fx - dir * (s + s * 0.9), fy + s * 0.55 + tail);
        cx.closePath(); cx.fill();
        cx.globalAlpha = 1;
    }
}

/* ---- winner breach ---- */
function breachY(st, team, x) {
    if (!(SIM.phase === 'settled' && SIM.winner === team)) { st.airborne = false; return 0; }
    const h = Math.pow(Math.abs(Math.sin(T * 2.6)), 1.4) * 100;
    if (h > 28) st.airborne = true;
    else if (st.airborne) {
        st.airborne = false;
        for (let j = 0; j < 18; j++)
            particles.push({ kind: 'spray', x: x + rand(-80, 80), y: waterY(x), vx: rand(-140, 140), vy: rand(-260, -60), life: 0, maxLife: 0.8, size: rand(2, 5) });
        particles.push({ kind: 'ripple', x, y: waterY(x), life: 0, maxLife: 1, size: 30 });
        sndSplash();
    }
    return h;
}

function smoothPath(pts) {
    cx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        cx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    cx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

/* ---- draw: rope + whales + chest ---- */
function drawRopeAndWhales() {
    const mx = posToX(SIM.pos);
    const rx = teamWaterX('red'), bx = teamWaterX('blue');

    if (SIM.phase === 'settled') {
        if (SIM.winner === 'red') whaleB.sink = Math.min(1, whaleB.sink + 0.004);
        else if (SIM.winner === 'blue') whaleR.sink = Math.min(1, whaleR.sink + 0.004);
    }
    const rBounce = breachY(whaleR, 'red', rx);
    const bBounce = breachY(whaleB, 'blue', bx);
    const ry = waterY(rx) + 12 + whaleR.sink * 150, by = waterY(bx) + 12 + whaleB.sink * 150;

    const total = SIM.red + SIM.blue;
    const balance = total > 0 ? 1 - Math.abs(SIM.red - SIM.blue) / total : 0;
    const tension = SIM.phase === 'live' ? balance : 0.2;
    const sag = lerp(44, 8, tension);
    const vib = tension > 0.55 ? (tension - 0.55) * 14 : 0;
    const chestY = waterY(mx) - 6 + Math.sin(T * 3) * 4;

    cx.strokeStyle = '#c9a06a'; cx.lineWidth = 5;
    cx.shadowColor = 'rgba(0,0,0,0.6)'; cx.shadowBlur = 6;
    cx.beginPath();
    cx.moveTo(rx + 58 * VS, ry - rBounce);
    cx.quadraticCurveTo((rx + mx) / 2 + rand(-vib, vib), Math.max(ry, chestY) + sag + rand(-vib, vib), mx, chestY);
    cx.quadraticCurveTo((mx + bx) / 2 + rand(-vib, vib), Math.max(by, chestY) + sag + rand(-vib, vib), bx - 58 * VS, by - bBounce);
    cx.stroke();
    cx.strokeStyle = 'rgba(255,224,160,0.45)'; cx.lineWidth = 1.6; cx.stroke();
    cx.shadowBlur = 0;

    if (vib > 2 && Math.random() < 0.5)
        particles.push({ kind: 'spark', x: mx + rand(-6, 6), y: chestY + rand(-6, 6), vx: rand(-50, 50), vy: rand(-80, -20), life: 0, maxLife: 0.4, size: rand(1.5, 3) });

    drawWhale(rx, ry - rBounce, 'red', whaleR);
    drawWhale(bx, by - bBounce, 'blue', whaleB);
    drawChest(mx, chestY);
}

function drawWhale(x, y, team, st) {
    const facing = team === 'red' ? 1 : -1;
    const live = SIM.phase === 'live';
    const winning = live && (team === 'red') === (SIM.pos < 50);
    const dom = Math.abs(SIM.pos - 50) / 46;
    const effort = winning ? dom : 0;
    const fear = live && !winning && SIM.pos !== 50 ? dom : 0;
    const celebrating = SIM.phase === 'settled' && SIM.winner === team;
    const defeated = st.sink > 0.05;

    const heave = live ? Math.pow((Math.sin(T * 3.1 + st.heavePh) + 1) / 2, 3) : 0;
    const targetLean = live
        ? (winning ? -(0.14 + 0.10 * heave) * (0.4 + dom) : (0.10 + 0.06 * heave) * (0.4 + dom)) : 0;
    st.lean = lerp(st.lean, targetLean + (defeated ? 0.9 : 0), 0.07);

    st.nextBlink -= 1 / 60;
    if (st.nextBlink <= 0) { st.blink = 1; st.nextBlink = rand(1.5, 4.5); }
    st.blink = Math.max(0, st.blink - 0.08);
    const eyeOpen = defeated ? 1 : 1 - Math.sin(Math.min(1, st.blink) * Math.PI) * 0.92;

    const s = VS * (1 + Math.min(0.35, (team === 'red' ? SIM.red : SIM.blue) / 120000));
    const recoilS = 1 + st.recoil * 0.12;
    const bob = Math.sin(T * 1.6 + (team === 'red' ? 0 : 2)) * 5;
    st.sx = x; st.sy = y + bob; st.srad = 92 * s;

    cx.save();
    cx.translate(x, y + bob);
    cx.rotate(st.lean * facing);
    if (celebrating) cx.rotate(Math.sin(T * 2.6) * 0.28 * facing);
    cx.scale(facing * s * recoilS, s * recoilS);
    cx.globalAlpha = 1 - st.sink * 0.55;

    const body = team === 'red' ? '#e02052' : '#2272e0';
    const dark = team === 'red' ? '#8f1234' : '#12468f';
    const belly = team === 'red' ? '#ff7ea0' : '#7eb6ff';

    const N = 7, swimSpeed = 4 + effort * 7 + fear * 9, amp = 4 + effort * 9 + fear * 12;
    const widths = [30, 44, 46, 40, 30, 19, 10, 6];
    const spine = [];
    for (let i = 0; i <= N; i++) {
        const u = i / N;
        spine.push({ x: 85 - u * 180, y: Math.sin(T * swimSpeed - u * 2.6) * amp * Math.pow(u, 1.6) });
    }

    const tp = spine[N];
    const thrash = Math.sin(T * swimSpeed - 2.9) * (10 + effort * 8 + fear * 10);
    cx.fillStyle = dark;
    cx.beginPath();
    cx.moveTo(tp.x + 12, tp.y - 2);
    cx.quadraticCurveTo(tp.x - 26, tp.y - 34 + thrash, tp.x - 44, tp.y - 46 + thrash);
    cx.quadraticCurveTo(tp.x - 20, tp.y - 4, tp.x - 44, tp.y + 40 + thrash);
    cx.quadraticCurveTo(tp.x - 26, tp.y + 26 + thrash, tp.x + 12, tp.y + 6);
    cx.closePath(); cx.fill();

    const grad = cx.createLinearGradient(0, -50, 0, 34);
    grad.addColorStop(0, body); grad.addColorStop(1, dark);
    cx.fillStyle = grad;
    const outline = [{ x: 97, y: spine[0].y + 2 }];
    for (let i = 0; i <= N; i++) outline.push({ x: spine[i].x, y: spine[i].y - widths[i] });
    for (let i = N; i >= 0; i--) outline.push({ x: spine[i].x, y: spine[i].y + widths[i] * 0.78 });
    cx.beginPath(); smoothPath(outline); cx.closePath(); cx.fill();

    const dor = spine[3];
    cx.fillStyle = dark;
    cx.beginPath();
    cx.moveTo(dor.x + 18, dor.y - widths[3] + 4);
    cx.quadraticCurveTo(dor.x - 2, dor.y - widths[3] - 26, dor.x - 22, dor.y - widths[3] - 18);
    cx.quadraticCurveTo(dor.x - 16, dor.y - widths[3] + 2, dor.x - 26, dor.y - widths[3] + 6);
    cx.closePath(); cx.fill();

    cx.fillStyle = belly; cx.globalAlpha = (1 - st.sink * 0.55) * 0.45;
    cx.beginPath(); cx.ellipse(12, 20, 58, 12, 0, 0, TAU); cx.fill();
    cx.globalAlpha = 1 - st.sink * 0.55;

    const flap = Math.sin(T * (fear > 0.3 ? 16 : 5)) * (6 + fear * 14);
    cx.fillStyle = dark; cx.save();
    cx.translate(18, 20); cx.rotate((20 + flap) * Math.PI / 180);
    cx.beginPath(); cx.ellipse(0, 14, 10, 24, 0, 0, TAU); cx.fill();
    cx.restore();

    const headY = spine[0].y;
    let lookX = 1, lookY = 0.15;
    const mdx = (MOUSE.x - x) * facing, mdy = MOUSE.y - (y + bob), md = Math.hypot(mdx, mdy);
    if (md < 260) { lookX = mdx / (md || 1); lookY = mdy / (md || 1); }

    if (defeated) {
        cx.strokeStyle = '#fff'; cx.lineWidth = 4; cx.lineCap = 'round';
        cx.beginPath();
        cx.moveTo(44, headY - 26); cx.lineTo(60, headY - 12);
        cx.moveTo(60, headY - 26); cx.lineTo(44, headY - 12); cx.stroke();
    } else {
        cx.fillStyle = '#fff';
        cx.beginPath(); cx.ellipse(52, headY - 19, 9, Math.max(0.8, 9 * eyeOpen), 0, 0, TAU); cx.fill();
        cx.fillStyle = '#0a0a12';
        cx.beginPath(); cx.arc(52 + lookX * 3.5, headY - 19 + lookY * 3.2 * eyeOpen, 4.2, 0, TAU); cx.fill();
        cx.fillStyle = '#fff';
        cx.beginPath(); cx.arc(53.5 + lookX * 3.5, headY - 21.5 + lookY * 3.2, 1.4, 0, TAU); cx.fill();
        cx.strokeStyle = dark; cx.lineWidth = 5; cx.lineCap = 'round';
        cx.beginPath();
        if (effort > 0.1 || st.roar > 0.05) { cx.moveTo(40, headY - 35); cx.lineTo(63, headY - 27); }
        else if (fear > 0.15) { cx.moveTo(42, headY - 30 - fear * 8); cx.lineTo(62, headY - 33 - fear * 3); }
        else { cx.moveTo(42, headY - 32); cx.lineTo(62, headY - 32); }
        cx.stroke();
    }

    if (st.roar > 0.05 && !defeated) {
        const open = Math.sin(Math.min(1, st.roar) * Math.PI / 2) * 22;
        cx.fillStyle = '#3d0716';
        cx.beginPath();
        cx.moveTo(88, headY + 2);
        cx.quadraticCurveTo(62, headY + 6, 46, headY + 8);
        cx.quadraticCurveTo(62, headY + 10 + open, 86, headY + 8 + open);
        cx.closePath(); cx.fill();
        cx.fillStyle = '#ff8faa';
        cx.beginPath(); cx.ellipse(64, headY + 9 + open * 0.7, 10, 4, 0, 0, TAU); cx.fill();
    } else if (celebrating) {
        cx.strokeStyle = dark; cx.lineWidth = 4; cx.lineCap = 'round';
        cx.beginPath(); cx.moveTo(84, headY + 2); cx.quadraticCurveTo(66, headY + 16, 46, headY + 8); cx.stroke();
    } else if (fear > 0.25 || defeated) {
        cx.strokeStyle = dark; cx.lineWidth = 4; cx.lineCap = 'round';
        cx.beginPath(); cx.moveTo(84, headY + 9); cx.quadraticCurveTo(66, headY + 1, 48, headY + 9); cx.stroke();
    } else if (effort > 0.15) {
        cx.fillStyle = '#fff'; cx.fillRect(50, headY + 2, 32, 7);
        cx.strokeStyle = dark; cx.lineWidth = 1.5;
        for (let tx = 56; tx <= 78; tx += 6) { cx.beginPath(); cx.moveTo(tx, headY + 2); cx.lineTo(tx, headY + 9); cx.stroke(); }
        cx.lineWidth = 3; cx.strokeRect(50, headY + 2, 32, 7);
    } else {
        cx.strokeStyle = dark; cx.lineWidth = 4; cx.lineCap = 'round';
        cx.beginPath(); cx.moveTo(84, headY + 4); cx.quadraticCurveTo(64, headY + 9, 46, headY + 6); cx.stroke();
    }

    cx.fillStyle = '#c9a06a';
    cx.beginPath(); cx.arc(78, headY + 4, 4, 0, TAU); cx.fill();
    cx.restore();
    cx.globalAlpha = 1;

    if (fear > 0.5 && Math.random() < 0.09)
        particles.push({ kind: 'spray', x: x + facing * 40 * s, y: y + bob - 50 * s, vx: facing * rand(40, 100), vy: rand(-150, -60), life: 0, maxLife: 0.6, size: rand(2, 4) });
    if ((effort > 0.5 || st.roar > 0.4) && Math.random() < 0.03)
        for (let i = 0; i < 8; i++)
            particles.push({ kind: 'spray', x: x + rand(-8, 8), y: y + bob - 62 * s, vx: rand(-26, 26), vy: rand(-170, -90), life: 0, maxLife: 0.7, size: rand(1.5, 3.5) });
    if (defeated && Math.random() < 0.12)
        particles.push({ kind: 'spray', x: x + rand(-40, 40), y: y + rand(-10, 30), vx: 0, vy: rand(-60, -20), life: 0, maxLife: 1.2, size: rand(2, 5) });
}

function drawChest(x, y) {
    cx.save();
    cx.translate(x, y); cx.scale(VS, VS); cx.rotate(Math.sin(T * 2.4) * 0.08);
    cx.shadowColor = '#ffb800'; cx.shadowBlur = 26;
    cx.fillStyle = '#8a5a22'; cx.fillRect(-20, -14, 40, 26);
    cx.shadowBlur = 0;
    cx.fillStyle = '#a86f2d';
    cx.beginPath(); cx.moveTo(-20, -14); cx.quadraticCurveTo(0, -30, 20, -14); cx.closePath(); cx.fill();
    cx.fillStyle = '#ffb800'; cx.fillRect(-3, -26, 6, 38); cx.fillRect(-20, -4, 40, 4);
    const sp = Math.abs(Math.sin(T * 3.2));
    cx.fillStyle = `rgba(255,240,180,${sp})`;
    cx.beginPath(); cx.arc(10, -18, 2.5, 0, TAU); cx.fill();
    cx.restore();
}

/* ---- draw: match-point flash ---- */
function drawMatchPoint() {
    if (SIM.phase !== 'live' || (SIM.pos >= 15 && SIM.pos <= 85)) return;
    const team = SIM.pos < 15 ? 'RED' : 'BLUE';
    const col = SIM.pos < 15 ? '#ff2a5f' : '#2a86ff';
    const fl = 0.6 + 0.4 * Math.sin(T * 10);
    cx.font = '900 26px "Segoe UI", sans-serif'; cx.textAlign = 'center';
    cx.fillStyle = col; cx.globalAlpha = fl; cx.shadowColor = col; cx.shadowBlur = 24;
    cx.fillText(`⚡ ${team} CLOSING IT OUT ⚡`, W / 2, H * 0.72);
    cx.shadowBlur = 0; cx.globalAlpha = 1;
}

/* ---- draw: particles ---- */
function drawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life > p.maxLife) { particles.splice(i, 1); continue; }
        if (p.life < 0) continue;
        const t = p.life / p.maxLife;

        if (p.kind === 'coin') {
            p.vy += 380 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
            const wy = waterY(p.x);
            if (p.y >= wy && p.vy > 0) {
                for (let j = 0; j < 4; j++)
                    particles.push({ kind: 'spray', x: p.x, y: wy, vx: rand(-60, 60), vy: rand(-160, -60), life: 0, maxLife: 0.5, size: rand(1, 3) });
                particles.push({ kind: 'ripple', x: p.x, y: wy, life: 0, maxLife: 0.8, size: 4 });
                particles.splice(i, 1); continue;
            }
            cx.fillStyle = '#ffb800'; cx.strokeStyle = '#c98a00'; cx.lineWidth = 1;
            cx.beginPath(); cx.ellipse(p.x, p.y, p.size, p.size * Math.abs(Math.sin(p.life * 9)), 0, 0, TAU);
            cx.fill(); cx.stroke();
        } else if (p.kind === 'spray') {
            p.vy += 500 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
            cx.fillStyle = `rgba(200,230,255,${1 - t})`;
            cx.beginPath(); cx.arc(p.x, p.y, p.size, 0, TAU); cx.fill();
        } else if (p.kind === 'spark') {
            p.vy += 200 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
            cx.fillStyle = `rgba(255,214,90,${1 - t})`;
            cx.beginPath(); cx.arc(p.x, p.y, p.size, 0, TAU); cx.fill();
        } else if (p.kind === 'ripple') {
            cx.strokeStyle = `rgba(200,230,255,${(1 - t) * 0.6})`; cx.lineWidth = 1.5;
            cx.beginPath(); cx.ellipse(p.x, p.y, p.size + t * 46, (p.size + t * 46) * 0.28, 0, 0, TAU); cx.stroke();
        } else if (p.kind === 'ring') {
            const col = p.team === 'red' ? '255,42,95' : '42,134,255';
            cx.strokeStyle = `rgba(${col},${1 - t})`; cx.lineWidth = 4 * (1 - t) + 1;
            cx.beginPath(); cx.ellipse(p.x, p.y, p.size + t * 220, (p.size + t * 220) * 0.4, 0, 0, TAU); cx.stroke();
        } else if (p.kind === 'text') {
            p.y += p.vy * dt;
            cx.font = `900 ${p.size}px "Segoe UI", sans-serif`; cx.textAlign = 'center';
            cx.fillStyle = p.team === 'red' ? '#ff5c84' : '#5ca4ff';
            cx.globalAlpha = 1 - t; cx.fillText(p.text, p.x, p.y); cx.globalAlpha = 1;
        }
    }
    if (particles.length > 500) particles.splice(0, particles.length - 500);
}

/* ---- main scene loop ---- */
function drawScene(dt) {
    VS = clamp(W / 760, 0.5, 1.0);   // whales/chest/fish shrink on narrow screens
    shake = Math.max(0, shake - dt * 22);
    lightning = Math.max(0, lightning - dt * 2.6);
    whaleR.recoil = Math.max(0, whaleR.recoil - dt * 2);
    whaleB.recoil = Math.max(0, whaleB.recoil - dt * 2);
    whaleR.roar = Math.max(0, whaleR.roar - dt * 1.1);
    whaleB.roar = Math.max(0, whaleB.roar - dt * 1.1);
    prevRM = SIM.rMult; prevBM = SIM.bMult;

    cx.save();
    if (shake > 0.3) cx.translate(rand(-shake, shake), rand(-shake, shake));
    drawSky();
    drawSea();
    drawDangerZones();
    drawFish(fishR, 'red');
    drawFish(fishB, 'blue');
    drawRopeAndWhales();
    drawParticles(dt);
    drawMatchPoint();
    cx.restore();
}

let lastFrame = performance.now();
function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    T += dt;
    syncSIM(dt);
    syncFish();
    cx.clearRect(0, 0, W, H);
    drawScene(dt);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ================= AUTH FLOW ================= */
function enterArena() {
    const name = el.nameInput.value.trim();
    if (!name) { el.nameInput.focus(); return; }
    doAuth(name);
}
el.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') enterArena(); });

function doAuth(name) {
    socket.emit('auth', { token: localStorage.getItem('ww_token'), name }, res => {
        if (!res || !res.ok) { toast(res && res.error || 'Could not join'); return; }
        me.token = res.token;
        me.name = res.name;
        me.balance = res.balance;
        me.position = res.position;
        localStorage.setItem('ww_token', res.token);
        localStorage.setItem('ww_name', res.name);
        el.modal.classList.remove('show');
        renderBalance(); renderActions();
        snd.join();
    });
}

socket.on('connect', () => {
    el.conn.classList.remove('show');
    // returning player: auto-auth silently
    const savedName = localStorage.getItem('ww_name');
    if (savedName) {
        el.modal.classList.remove('show');
        doAuth(savedName);
    } else {
        el.nameInput.focus();
    }
});
socket.on('disconnect', () => el.conn.classList.add('show'));

socket.on('hello', h => {
    CFGC = { ...CFGC, ...h };
    el.edgeNote.textContent = `House edge ${(CFGC.edge * 100).toFixed(1)}% applied on payouts · 🪙${CFGC.whaleMin.toLocaleString()}+ triggers Whale Alert`;
    if (h.state) { ST = h.state; renderAll(); onPhaseChange(ST.phase); el.roundNum.textContent = ST.id; }
});

/* ================= SERVER STATE ================= */
socket.on('state', s => {
    const phaseChanged = ST && ST.phase !== s.phase;
    const roundChanged = ST && ST.id !== s.id;
    ST = s;
    if (roundChanged) onNewRound();
    if (phaseChanged) onPhaseChange(s.phase);
    renderAll();
    if (s.phase === 'betting' && s.tLeft <= 3.05 && s.tLeft > 0 && Math.abs(s.tLeft % 1) < 0.11) snd.tick();
});

function onPhaseChange(phase) {
    if (phase === 'live') {
        el.timerPhase.textContent = '⚔️ Live Battle';
        el.timerPhase.classList.add('live');
    } else if (phase === 'betting') {
        el.timerPhase.textContent = 'Accepting Bets';
        el.timerPhase.classList.remove('live');
    } else if (phase === 'settled') {
        el.timerPhase.textContent = 'Settling Stakes';
        el.timerPhase.classList.remove('live');
    }
    renderActions();
}

function onNewRound() {
    me.position = null;
    el.overlay.classList.remove('show');
    el.cashBtn.classList.remove('done', 'locked');
    el.cashBtn.disabled = false;
    el.timerPhase.textContent = 'Accepting Bets';
    el.timerPhase.classList.remove('live');
    // resurface both whales for the new round
    whaleR.sink = 0; whaleR.airborne = false;
    whaleB.sink = 0; whaleB.airborne = false;
    renderActions();
}

socket.on('round:new', d => { el.roundNum.textContent = d.round; });
socket.on('online', n => { el.online.textContent = n.toLocaleString('en-US'); });
socket.on('leaderboard', list => renderLeaderboard(list));

socket.on('feed:bet', b => {
    addBetEntry(b.team, b.name, b.amount, { boost: b.boost, mine: b.name === me.name });
    coinSplash(b.team, b.amount, b.whale);
});

socket.on('whale', w => {
    whaleBanner(`🐋 WHALE ALERT: ${w.name} dropped ${fmtC(w.amount)} on ${w.team.toUpperCase()}!`);
    whaleEvent(w.team, w.amount);
});

socket.on('chat', c => {
    if (c.system) addChat('system', 'System', c.text);
    else addChat(c.name === me.name ? 'you' : (c.team || 'neutral'), c.name, c.text);
});

/* ================= ROUND END ================= */
socket.on('round:end', d => {
    if (typeof d.balance === 'number') { me.balance = d.balance; renderBalance(); }

    history.push(d.winner);
    if (history.length > 10) history.shift();
    renderHistory();

    el.ovTitle.textContent = `Team ${d.winner} Wins`;
    el.ovTitle.className = d.winner;
    el.ovSub.textContent = `Final multiplier ${d.finalMult.toFixed(2)}x · Pools ${fmtC(d.red)} vs ${fmtC(d.blue)}`;

    const r = d.result || { kind: 'spectator' };
    let html = '';
    if (r.kind === 'won') {
        html = `You held to the end at ${r.mult.toFixed(2)}x<span class="win-amt">+${fmtC(r.amount)}</span>`;
        confettiBurst(); snd.win();
    } else if (r.kind === 'lost') {
        html = `Your position was liquidated<span class="lose-amt">−${fmtC(r.amount)}</span>`;
        snd.lose();
    } else if (r.kind === 'banked') {
        html = `Smart exit — you banked earlier at ${r.mult.toFixed(2)}x<span class="win-amt">+${fmtC(r.amount)}</span>`;
        if (r.teamWon && r.wouldHave > r.amount) {
            html += `<div class="neutral">Holding would have paid ${fmtC(r.wouldHave)}…</div>`;
        } else if (!r.teamWon) {
            html += `<div class="neutral">Perfect read — your team lost after you left. 🧠</div>`;
        }
    } else {
        html = `<span class="neutral">You spectated this round. Jump in next time.</span>`;
    }
    el.ovOutcome.innerHTML = html; // built above from server numbers only
    el.overlay.classList.add('show');
});

/* ================= RENDER ================= */
function renderAll() {
    if (!ST) return;
    renderTimer(); renderPools(); renderMults(); renderPosition();
    if (ST.phase === 'settled') el.ovCount.textContent = Math.max(0, Math.ceil(ST.tLeft));
}

function renderBalance() {
    el.balance.textContent = fmtC(me.balance);
    el.refill.style.display = me.balance < 500 ? '' : 'none';
}

function renderPools() {
    el.redPool.textContent = fmtC(ST.red);
    el.bluePool.textContent = fmtC(ST.blue);
    el.redBettors.textContent = ST.redBettors + ' fighters';
    el.blueBettors.textContent = ST.blueBettors + ' fighters';
}

function renderMults() {
    el.redMult.textContent = ST.rMult.toFixed(2) + 'x';
    el.blueMult.textContent = ST.bMult.toFixed(2) + 'x';
    el.redMult.classList.toggle('dead', ST.rMult <= 0);
    el.blueMult.classList.toggle('dead', ST.bMult <= 0);
    el.redHud.classList.toggle('winning', ST.phase === 'live' && ST.pos < 50);
    el.blueHud.classList.toggle('winning', ST.phase === 'live' && ST.pos > 50);
}

function renderTimer() {
    const totals = { betting: CFGC.betSecs, live: CFGC.liveSecs, settled: CFGC.settleSecs };
    const total = totals[ST.phase] || 10;
    el.timerText.textContent = Math.max(0, Math.ceil(ST.tLeft));
    const C = 251.33;
    el.timerRing.style.strokeDashoffset = (C * (1 - clamp(ST.tLeft / total, 0, 1))).toFixed(1);
    el.timerRing.style.stroke = ST.phase === 'live'
        ? (ST.tLeft < 8 ? 'var(--red)' : 'var(--gold)') : 'var(--gold)';
}

function myMult() {
    if (!me.position) return 0;
    return me.position.team === 'red' ? ST.rMult : ST.bMult;
}
function netValue(stake, mult) { return stake * mult * (1 - CFGC.edge); }

function renderPosition() {
    if (!me.position) return;
    const pos = me.position;
    const m = myMult();
    const val = pos.out ? pos.banked : netValue(pos.stake, m);
    const profit = val - pos.stake;
    el.posStake.textContent = fmtC(pos.stake);
    el.posValue.textContent = fmtC(val) + (pos.out ? ' (banked)' : '');
    el.posProfit.textContent = (profit >= 0 ? '+' : '') + fmtC(profit);
    el.posProfit.className = profit >= 0 ? 'up' : 'down';

    if (!pos.out && ST.phase === 'live') {
        if (m > 0) {
            el.cashBtn.classList.remove('locked');
            el.cashBtn.disabled = false;
            el.cashVal.textContent = fmtC(netValue(pos.stake, m));
        } else {
            el.cashBtn.classList.add('locked');
            el.cashBtn.disabled = true;
            el.cashVal.textContent = '0.00x — boost to fight back!';
        }
    }
}

function renderActions() {
    if (!ST) return;
    const betting = ST.phase === 'betting';
    const live = ST.phase === 'live';
    const joined = !!me.position;

    el.joinRed.style.display = betting && !joined ? 'flex' : 'none';
    el.joinBlue.style.display = betting && !joined ? 'flex' : 'none';
    el.posCard.style.display = joined ? 'flex' : 'none';
    el.boostBtn.style.display = live && joined && !me.position.out ? 'flex' : 'none';
    el.cashBtn.style.display = live && joined ? 'flex' : 'none';
    el.spectate.style.display = live && !joined ? 'flex' : 'none';

    if (joined) {
        el.posTeam.textContent = me.position.team.toUpperCase();
        el.posTeam.className = 'team-tag ' + me.position.team;
        el.boostLabel.textContent = `stake more on ${me.position.team.toUpperCase()}`;
    }
    if (joined && me.position.out) {
        el.cashBtn.classList.add('done');
        el.cashBtn.disabled = true;
        el.cashBtn.firstChild.textContent = 'Cashed Out ';
        el.cashVal.textContent = `banked ${fmtC(me.position.banked)} @ ${me.position.outMult.toFixed(2)}x`;
    } else {
        el.cashBtn.classList.remove('done');
        el.cashBtn.firstChild.textContent = 'Cash Out ';
    }
}

function renderHistory() {
    el.history.querySelectorAll('.h-chip').forEach(c => c.remove());
    for (const w of history) {
        const c = document.createElement('div');
        c.className = 'h-chip ' + w;
        c.textContent = w === 'red' ? 'R' : 'B';
        el.history.appendChild(c);
    }
}

/* ================= EFFECTS ================= */
let whaleTimeout = null;
function whaleBanner(msg) {
    // canvas whaleEvent() handles the shake, horn and roar; this is just the text banner
    el.whaleBanner.textContent = msg;
    el.whaleBanner.classList.add('active');
    clearTimeout(whaleTimeout);
    whaleTimeout = setTimeout(() => el.whaleBanner.classList.remove('active'), 3000);
}

function confettiBurst() {
    const colors = ['#ffb800', '#00c853', '#ff2a5f', '#2a86ff', '#ffffff'];
    for (let i = 0; i < 70; i++) {
        const c = document.createElement('div');
        c.className = 'confetto';
        c.style.left = rand(0, 100) + '%';
        c.style.background = pick(colors);
        c.style.animationDuration = rand(1.6, 3.2) + 's';
        c.style.animationDelay = rand(0, 0.5) + 's';
        c.style.transform = `rotate(${rand(0, 360)}deg)`;
        el.confetti.appendChild(c);
    }
    setTimeout(() => { el.confetti.innerHTML = ''; }, 4200);
}

/* ================= FEEDS ================= */
function trimFeed(box) { while (box.childElementCount > 45) box.firstChild.remove(); }

function addChat(kind, user, text) {
    const d = document.createElement('div');
    d.className = kind === 'system' ? 'chat-msg sys-msg' : `chat-msg ${kind}-user`;
    const u = document.createElement('span'); u.className = 'user';
    if (kind !== 'system') u.textContent = user + ':';
    const b = document.createElement('span'); b.className = 'msg-body'; b.textContent = text;
    d.appendChild(u); d.appendChild(b);
    el.chatBox.appendChild(d);
    trimFeed(el.chatBox);
    el.chatBox.scrollTop = el.chatBox.scrollHeight;
    // ping the mobile toggle when the sheet is closed and someone's talking
    if (kind !== 'you' && !document.body.classList.contains('sidebar-open')) {
        const ct = $('chat-toggle'); if (ct) ct.classList.add('unread');
    }
}

function addBetEntry(team, who, amt, opts = {}) {
    const d = document.createElement('div');
    d.className = 'bet-entry' + (amt >= CFGC.whaleMin ? ' whale-bet' : '') + (opts.mine ? ' mine' : '');
    const dot = document.createElement('span'); dot.className = 'dot ' + team;
    const w = document.createElement('span'); w.className = 'who';
    w.textContent = (amt >= CFGC.whaleMin ? '🐋 ' : '') + who;
    const verb = document.createElement('span');
    verb.textContent = opts.boost ? 'boosted' : 'bet';
    verb.style.color = 'var(--muted)';
    const a = document.createElement('span'); a.className = 'amt'; a.textContent = fmtC(amt);
    d.append(dot, w, verb, a);
    el.betsBox.appendChild(d);
    trimFeed(el.betsBox);
    el.betsBox.scrollTop = el.betsBox.scrollHeight;
}

function switchTab(tab) {
    $('tab-chat').classList.toggle('active', tab === 'chat');
    $('tab-bets').classList.toggle('active', tab === 'bets');
    $('tab-leaders').classList.toggle('active', tab === 'leaders');
    el.chatBox.classList.toggle('active', tab === 'chat');
    el.betsBox.classList.toggle('active', tab === 'bets');
    el.leadersBox.classList.toggle('active', tab === 'leaders');
}

// mobile bottom-sheet War Room toggle
function toggleSidebar() {
    const open = document.body.classList.toggle('sidebar-open');
    if (open) $('chat-toggle').classList.remove('unread');
}

function renderLeaderboard(list) {
    el.leadersBox.innerHTML = '';
    if (!list || !list.length) {
        const empty = document.createElement('div');
        empty.className = 'lb-empty';
        empty.textContent = 'No players yet — be the first on the board.';
        el.leadersBox.appendChild(empty);
        return;
    }
    for (const row of list) {
        const d = document.createElement('div');
        d.className = 'lb-row' + (row.name === me.name ? ' mine' : '') + (row.rank <= 3 ? ' top3' : '');
        const rank = document.createElement('span');
        rank.className = 'lb-rank';
        rank.textContent = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : '#' + row.rank;
        const name = document.createElement('span');
        name.className = 'lb-name';
        name.textContent = row.name + (row.name === me.name ? ' (you)' : '');
        const bal = document.createElement('span');
        bal.className = 'lb-bal';
        bal.textContent = fmtC(row.balance);
        d.append(rank, name, bal);
        el.leadersBox.appendChild(d);
    }
}

/* ================= BET INPUT ================= */
function getBetAmount() {
    const v = Math.floor(parseFloat(el.betInput.value));
    return isNaN(v) ? 0 : v;
}
function setBet(a) { el.betInput.value = a; }
function mulBet(f) { el.betInput.value = Math.max(1, Math.floor(getBetAmount() * f)); }
function flagBetError() {
    el.betRow.classList.remove('error');
    void el.betRow.offsetWidth;
    el.betRow.classList.add('error');
}

/* ================= ACTIONS (intents to server) ================= */
function joinTeam(team) {
    const amount = getBetAmount();
    if (amount < 1) { flagBetError(); return; }
    socket.emit('bet', { team, amount }, res => {
        if (res.error) { flagBetError(); toast(res.error); return; }
        me.balance = res.balance;
        me.position = res.position;
        renderBalance(); renderActions(); renderPosition();
        snd.join();
        addChat('you', 'You', `Locked in ${fmtC(amount)} on Team ${team.toUpperCase()}! 🔒`);
    });
}

function injectBoost() {
    const amount = getBetAmount();
    if (amount < 1) { flagBetError(); return; }
    socket.emit('boost', { amount }, res => {
        if (res.error) { flagBetError(); toast(res.error); return; }
        me.balance = res.balance;
        me.position = res.position;
        renderBalance(); renderPosition();
        snd.boost();
    });
}

function triggerCashout() {
    socket.emit('cashout', {}, res => {
        if (res.error) { toast(res.error); return; }
        me.balance = res.balance;
        me.position = res.position;
        renderBalance(); renderActions(); renderPosition();
        snd.cashout();
    });
}

function refillDemo() {
    socket.emit('refill', {}, res => {
        if (res.error) { toast(res.error); return; }
        me.balance = res.balance;
        renderBalance();
        addChat('system', 'System', '💰 Free coins claimed (+🪙10,000)!');
    });
}

function sendChatMessage() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    if (!me.token) { toast('Enter a name to chat'); return; }
    socket.emit('chat', { text });
    el.chatInput.value = '';
}
el.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });

/* ================= BOOT ================= */
const savedName = localStorage.getItem('ww_name');
if (savedName) el.nameInput.value = savedName;
addChat('system', 'System', '🐋 Welcome to Whale Wars. Two teams, one rope, 45 seconds.');
