'use strict';

const { EventEmitter } = require('events');
const CFG = require('./config');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Server-authoritative round engine.
 *
 * All money movement happens here. Clients only send intents
 * (bet / boost / cashout) and render the broadcast state.
 *
 * Events emitted:
 *   'state'   snapshot (every tick, 10Hz)
 *   'phase'   'live' when battle starts
 *   'bet'     { name, team, amount, boost, whale }  — public feed entry
 *   'whale'   { name, team, amount }                — global alert
 *   'chat'    { name, team, text, system }
 *   'round'   newRoundId
 *   'settled' { winner, finalMult, red, blue, results: Map<token, result> }
 */
class Engine extends EventEmitter {
    constructor(players) {
        super();
        this.players = players;
        this.roundId = 1;
        this.positions = new Map(); // token -> { team, stake }
        this.round = this._freshRound();
        this.timer = null;
    }

    _freshRound() {
        return {
            id: this.roundId,
            phase: 'betting',           // betting | live | settled
            tLeft: CFG.BET_SECS,
            red: 0, blue: 0,            // pool totals ($)
            redBettors: 0, blueBettors: 0,
            pos: 50, vel: 0,            // rope physics
            rMult: 1.00, bMult: 1.00,
            winner: null, finalMult: 0,
        };
    }

    start() { if (!this.timer) this.timer = setInterval(() => this.tick(), CFG.TICK_MS); }
    stop() { clearInterval(this.timer); this.timer = null; }

    snapshot() {
        const r = this.round;
        return {
            id: r.id, phase: r.phase, tLeft: +r.tLeft.toFixed(2),
            pos: +r.pos.toFixed(2),
            red: Math.round(r.red), blue: Math.round(r.blue),
            redBettors: r.redBettors, blueBettors: r.blueBettors,
            rMult: +r.rMult.toFixed(2), bMult: +r.bMult.toFixed(2),
            winner: r.winner,
        };
    }

    /* ---------------- game loop ---------------- */

    tick() {
        const r = this.round;
        r.tLeft -= CFG.TICK_MS / 1000;

        if (r.phase === 'betting') {
            // gentle preview lean toward the heavier pool
            r.pos += (this._ropeTarget() - r.pos) * 0.06;
            if (r.tLeft <= 0) {
                r.phase = 'live';
                r.tLeft = CFG.LIVE_SECS;
                r.vel = 0;
                this.emit('phase', 'live');
                this.systemChat(`Round ${r.id} is LIVE — ${CFG.LIVE_SECS} seconds. Fight for the rope!`);
            }
        } else if (r.phase === 'live') {
            this._stepRope();
            if (r.tLeft <= 0) return this._settle();
        } else if (r.phase === 'settled') {
            if (r.tLeft <= 0) return this._newRound();
        }

        this._updateOdds();   // live pari-mutuel odds from the current pools
        this.emit('state', this.snapshot());
    }

    /* ---------------- rope physics ---------------- */

    // Rope target derives from the live pool ratio — the core hook.
    _ropeTarget() {
        const r = this.round;
        const total = r.red + r.blue;
        if (total <= 0) return 50;
        const skew = (r.blue - r.red) / total;          // -1 .. +1
        const range = r.phase === 'live' ? 42 : 10;
        return 50 + clamp(skew * range * 1.4, -range, range);
    }

    _stepRope() {
        const r = this.round;
        r.vel += (this._ropeTarget() - r.pos) * 0.045;  // spring toward pool ratio
        r.vel += (Math.random() - 0.5) * 0.35;          // crowd chaos
        r.vel *= 0.88;                                  // damping
        r.pos += r.vel;
        if (r.pos < CFG.ROPE_MIN) { r.pos = CFG.ROPE_MIN; r.vel *= -0.3; }
        if (r.pos > CFG.ROPE_MAX) { r.pos = CFG.ROPE_MAX; r.vel *= -0.3; }
    }

    // Pari-mutuel odds: if a team wins, its backers split the whole net pool.
    // multiplier = (net pool) / (that team's pool)  →  underdog pays more.
    _updateOdds() {
        const r = this.round;
        const total = r.red + r.blue;
        if (total <= 0) { r.rMult = 1.00; r.bMult = 1.00; return; }
        const net = total * (1 - CFG.HOUSE_EDGE);   // house edge skimmed off the top
        r.rMult = r.red > 0 ? +(net / r.red).toFixed(2) : 0;
        r.bMult = r.blue > 0 ? +(net / r.blue).toFixed(2) : 0;
    }

    _impulse(team, amount) {
        const dir = team === 'red' ? -1 : 1;
        this.round.vel += dir * clamp(1.2 + amount / 8000, 0, 6.5);
    }

    /* ---------------- money (virtual coins, integers) ---------------- */

    _validAmount(amount) {
        const a = Math.floor(Number(amount));
        if (!Number.isFinite(a) || a < CFG.MIN_BET || a > CFG.MAX_BET) return null;
        return a;
    }

    _announceMoney(name, team, amount, boost) {
        this.emit('bet', { name, team, amount, boost, whale: amount >= CFG.WHALE_MIN });
        if (amount >= CFG.WHALE_MIN && this.round.phase === 'live') {
            this._impulse(team, amount);
        }
        if (amount >= CFG.WHALE_MIN) {
            this.emit('whale', { name, team, amount });
        }
    }

    placeBet(token, team, amount) {
        const r = this.round;
        const p = this.players.get(token);
        if (!p) return { error: 'Not authenticated' };
        if (r.phase !== 'betting') return { error: 'Betting window is closed' };
        if (this.positions.has(token)) return { error: 'You are already locked into this round' };
        if (team !== 'red' && team !== 'blue') return { error: 'Invalid team' };
        const amt = this._validAmount(amount);
        if (amt === null) return { error: `Bet must be 🪙${CFG.MIN_BET}–🪙${CFG.MAX_BET.toLocaleString()}` };
        if (amt > p.balance) return { error: 'Not enough coins' };

        p.balance = Math.round(p.balance - amt);
        const position = { team, stake: amt };
        this.positions.set(token, position);
        r[team] += amt;
        if (team === 'red') r.redBettors++; else r.blueBettors++;
        this._announceMoney(p.name, team, amt, false);
        this._updateOdds();
        this.players.save();
        return { ok: true, balance: p.balance, position };
    }

    boost(token, amount) {
        const r = this.round;
        const p = this.players.get(token);
        const pos = this.positions.get(token);
        if (!p) return { error: 'Not authenticated' };
        if (r.phase !== 'live') return { error: 'Boosts only work during the live battle' };
        if (!pos) return { error: 'You have no position this round' };
        const amt = this._validAmount(amount);
        if (amt === null) return { error: `Boost must be 🪙${CFG.MIN_BET}–🪙${CFG.MAX_BET.toLocaleString()}` };
        if (amt > p.balance) return { error: 'Not enough coins' };

        p.balance = Math.round(p.balance - amt);
        pos.stake += amt;
        r[pos.team] += amt;
        // boosts always kick the rope; whales kick harder via _announceMoney
        if (amt < CFG.WHALE_MIN) this._impulse(pos.team, Math.max(amt, 1200));
        this._announceMoney(p.name, pos.team, amt, true);
        this._updateOdds();
        this.players.save();
        return { ok: true, balance: p.balance, position: pos };
    }

    // Pari-mutuel has no mid-round cashout (it would let underdogs drain the pool).
    // A player may only cancel their bet during the betting window — full refund.
    cancelBet(token) {
        const r = this.round;
        const p = this.players.get(token);
        const pos = this.positions.get(token);
        if (!p) return { error: 'Not authenticated' };
        if (r.phase !== 'betting') return { error: 'You can only cancel during the betting window' };
        if (!pos) return { error: 'You have no bet to cancel' };

        p.balance = Math.round(p.balance + pos.stake);
        r[pos.team] -= pos.stake;
        if (pos.team === 'red') r.redBettors--; else r.blueBettors--;
        this.positions.delete(token);
        this._updateOdds();
        this.players.save();
        return { ok: true, balance: p.balance, position: null };
    }

    // Simulated liquidity (bots) — money enters pools but no player is paid.
    systemBet(name, team, amount) {
        const r = this.round;
        if (r.phase !== 'betting' && r.phase !== 'live') return;
        r[team] += amount;
        if (team === 'red') r.redBettors++; else r.blueBettors++;
        this._announceMoney(name, team, amount, r.phase === 'live');
    }

    systemChat(text, name = null, team = null) {
        this.emit('chat', { name, team, text, system: !name });
    }

    /* ---------------- settlement ---------------- */

    // Pari-mutuel settlement: the whole net pool (total minus the house edge) is
    // split among the winning team's backers, in proportion to how much each staked.
    _settle() {
        const r = this.round;
        r.phase = 'settled';
        r.tLeft = CFG.SETTLE_SECS;
        r.winner = r.pos < 50 ? 'red' : 'blue';

        const total = r.red + r.blue;
        const net = Math.round(total * (1 - CFG.HOUSE_EDGE));   // winners share this
        const winningPool = r.winner === 'red' ? r.red : r.blue;
        r.finalMult = winningPool > 0 ? +(net / winningPool).toFixed(2) : 0;

        const results = new Map();
        let paidOut = 0;
        for (const [token, pos] of this.positions) {
            const p = this.players.get(token);
            if (pos.team === r.winner && winningPool > 0) {
                const payout = Math.round(net * (pos.stake / winningPool));   // pro-rata by stake
                p.balance = Math.round(p.balance + payout);
                paidOut += payout;
                results.set(token, { kind: 'won', amount: payout, stake: pos.stake, mult: +(payout / pos.stake).toFixed(2) });
            } else {
                results.set(token, { kind: 'lost', amount: pos.stake });
            }
        }
        this.players.save();
        console.log(`[SETTLE] round ${r.id} ${r.winner} | pool ${total} | net ${net} | paid ${paidOut} | house ~${total - paidOut}`);
        this.systemChat(`Team ${r.winner.toUpperCase()} wins round ${r.id} — backers split the pool at ${r.finalMult.toFixed(2)}x!`);
        this.emit('settled', {
            winner: r.winner, finalMult: r.finalMult,
            red: Math.round(r.red), blue: Math.round(r.blue),
            results,
        });
        this.emit('state', this.snapshot());
    }

    _newRound() {
        this.roundId++;
        this.positions.clear();
        this.round = this._freshRound();
        this.emit('round', this.roundId);
        this.systemChat(`Round ${this.roundId} — betting open for ${CFG.BET_SECS}s. Pick your side.`);
        this.emit('state', this.snapshot());
    }
}

module.exports = Engine;
