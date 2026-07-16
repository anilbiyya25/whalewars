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
        this.positions = new Map(); // token -> { team, stake, out, outMult, banked }
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
            this._stepMults();
            if (r.tLeft <= 0) return this._settle();
        } else if (r.phase === 'settled') {
            if (r.tLeft <= 0) return this._newRound();
        }

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

    // Winning side compounds with dominance (capped at MAX_MULT so house
    // liability stays bounded); losing side collapses toward 0.
    _stepMults() {
        const r = this.round;
        const dom = Math.abs(r.pos - 50) / 46;
        const grow = 1 + dom * 0.0095;
        if (r.pos < 50) {
            r.rMult = Math.min(CFG.MAX_MULT, Math.max(r.rMult, 1.0) * grow);
            r.bMult = r.bMult > 0.05 ? r.bMult * 0.88 : 0;
        } else if (r.pos > 50) {
            r.bMult = Math.min(CFG.MAX_MULT, Math.max(r.bMult, 1.0) * grow);
            r.rMult = r.rMult > 0.05 ? r.rMult * 0.88 : 0;
        }
    }

    _impulse(team, amount) {
        const dir = team === 'red' ? -1 : 1;
        this.round.vel += dir * clamp(1.2 + amount / 8000, 0, 6.5);
    }

    /* ---------------- money (virtual coins, integers) ---------------- */

    net(stake, mult) { return Math.round(stake * mult * (1 - CFG.HOUSE_EDGE)); }

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
        const position = { team, stake: amt, out: false, outMult: 0, banked: 0 };
        this.positions.set(token, position);
        r[team] += amt;
        if (team === 'red') r.redBettors++; else r.blueBettors++;
        this._announceMoney(p.name, team, amt, false);
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
        if (pos.out) return { error: 'You already cashed out' };
        const amt = this._validAmount(amount);
        if (amt === null) return { error: `Boost must be 🪙${CFG.MIN_BET}–🪙${CFG.MAX_BET.toLocaleString()}` };
        if (amt > p.balance) return { error: 'Not enough coins' };

        p.balance = Math.round(p.balance - amt);
        pos.stake += amt;
        r[pos.team] += amt;
        // boosts always kick the rope; whales kick harder via _announceMoney
        if (amt < CFG.WHALE_MIN) this._impulse(pos.team, Math.max(amt, 1200));
        this._announceMoney(p.name, pos.team, amt, true);
        this.players.save();
        return { ok: true, balance: p.balance, position: pos };
    }

    cashout(token) {
        const r = this.round;
        const p = this.players.get(token);
        const pos = this.positions.get(token);
        if (!p) return { error: 'Not authenticated' };
        if (r.phase !== 'live') return { error: 'Cashout only works during the live battle' };
        if (!pos) return { error: 'You have no position this round' };
        if (pos.out) return { error: 'Already cashed out' };
        const mult = pos.team === 'red' ? r.rMult : r.bMult;
        if (mult <= 0) return { error: 'Your multiplier is 0x — boost to fight back' };

        pos.out = true;
        pos.outMult = +mult.toFixed(2);
        pos.banked = this.net(pos.stake, mult);
        p.balance = Math.round(p.balance + pos.banked);
        this.players.save();
        this.systemChat(`${p.name} cashed out at ${pos.outMult.toFixed(2)}x (+🪙${pos.banked.toLocaleString()})`);
        return { ok: true, balance: p.balance, position: pos };
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

    _settle() {
        const r = this.round;
        r.phase = 'settled';
        r.tLeft = CFG.SETTLE_SECS;
        r.winner = r.pos < 50 ? 'red' : 'blue';
        r.finalMult = +(r.winner === 'red' ? r.rMult : r.bMult).toFixed(2);

        const results = new Map();
        for (const [token, pos] of this.positions) {
            const p = this.players.get(token);
            let res;
            if (pos.out) {
                res = {
                    kind: 'banked', amount: pos.banked, mult: pos.outMult,
                    teamWon: pos.team === r.winner,
                    wouldHave: pos.team === r.winner ? this.net(pos.stake, r.finalMult) : 0,
                };
            } else if (pos.team === r.winner) {
                const payout = this.net(pos.stake, r.finalMult);
                p.balance = Math.round(p.balance + payout);
                res = { kind: 'won', amount: payout, mult: r.finalMult };
            } else {
                res = { kind: 'lost', amount: pos.stake };
            }
            results.set(token, res);
        }
        this.players.save();
        this.systemChat(`Team ${r.winner.toUpperCase()} takes round ${r.id} at ${r.finalMult.toFixed(2)}x!`);
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
