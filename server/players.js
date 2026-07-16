'use strict';

const fs = require('fs');
const path = require('path');
const CFG = require('./config');

let createClient = null;
try { ({ createClient } = require('@supabase/supabase-js')); } catch { /* optional dep */ }

/**
 * Player registry.
 *
 * The in-memory Map is the hot source of truth during rounds (fast, no I/O in
 * the bet/cashout path). Persistence runs in the background:
 *   - Supabase Postgres if SUPABASE_URL + SUPABASE_SERVICE_KEY are set (survives
 *     redeploys), else a local JSON file (fine for dev; wiped on redeploy).
 * Only players whose balance actually changed are written, so a busy round
 * costs a handful of upserts, not a full table dump.
 */
class Players {
    constructor(file) {
        this.file = file || path.join(__dirname, '..', 'data', 'players.json');
        this.map = new Map();            // token -> { token, name, balance, created }
        this._lastSaved = new Map();     // token -> balance last persisted
        this._saveTimer = null;
        this._flushing = false;
        this._flushAgain = false;

        const url = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
        const key = process.env.SUPABASE_SERVICE_KEY || '';
        this.sb = (createClient && url && key)
            ? createClient(url, key, { auth: { persistSession: false } })
            : null;
        this.backend = this.sb ? 'supabase' : 'json';
    }

    /** Load all players into memory. Called once at boot (await it). */
    async init() {
        if (this.sb) {
            try {
                const pageSize = 1000;
                let from = 0, loaded = 0;
                for (;;) {
                    const { data, error } = await this.sb
                        .from('players')
                        .select('token,name,balance,created')
                        .range(from, from + pageSize - 1);
                    if (error) throw new Error(error.message);
                    for (const p of data) {
                        p.balance = Number(p.balance);
                        this.map.set(p.token, p);
                        this._lastSaved.set(p.token, p.balance);
                    }
                    loaded += data.length;
                    if (data.length < pageSize) break;
                    from += pageSize;
                }
                console.log(`[players] loaded ${loaded} player(s) from Supabase`);
                return;
            } catch (e) {
                console.error(`[players] Supabase load failed (${e.message}) — falling back to JSON file`);
                this.sb = null; this.backend = 'json';
            }
        }
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const p of raw) { this.map.set(p.token, p); this._lastSaved.set(p.token, p.balance); }
            console.log(`[players] loaded ${this.map.size} player(s) from disk`);
        } catch { /* first boot — no data yet */ }
    }

    get(token) { return this.map.get(token); }

    getOrCreate(token, name) {
        let p = this.map.get(token);
        if (!p) {
            p = { token, name, balance: CFG.START_BALANCE, created: Date.now() };
            this.map.set(token, p);
            this.save();
        }
        return p;
    }

    credit(token, amount) {
        const p = this.map.get(token);
        if (!p) return null;
        p.balance = Math.round(p.balance + amount);
        this.save();
        return p.balance;
    }

    debit(token, amount) {
        const p = this.map.get(token);
        if (!p || p.balance < amount) return null;
        p.balance = Math.round(p.balance - amount);
        this.save();
        return p.balance;
    }

    /** Top N players by balance, computed from memory (no DB query). */
    getLeaderboard(n = 10) {
        return [...this.map.values()]
            .sort((a, b) => b.balance - a.balance)
            .slice(0, n)
            .map((p, i) => ({ rank: i + 1, name: p.name, balance: p.balance }));
    }

    save() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._flush(), 800);
    }

    async _flush() {
        // avoid overlapping upserts; coalesce into one trailing run
        if (this._flushing) { this._flushAgain = true; return; }
        this._flushing = true;
        try {
            // only players whose balance changed since last persist
            const changed = [];
            for (const p of this.map.values()) {
                if (this._lastSaved.get(p.token) !== p.balance) changed.push(p);
            }
            if (changed.length) {
                if (this.sb) {
                    const now = new Date().toISOString();
                    const rows = changed.map(p => ({
                        token: p.token, name: p.name, balance: p.balance, created: p.created, updated_at: now,
                    }));
                    const { error } = await this.sb.from('players').upsert(rows, { onConflict: 'token' });
                    if (error) { console.error('[players] Supabase upsert failed:', error.message); return; }
                } else {
                    fs.mkdirSync(path.dirname(this.file), { recursive: true });
                    fs.writeFileSync(this.file, JSON.stringify([...this.map.values()], null, 2));
                }
                for (const p of changed) this._lastSaved.set(p.token, p.balance);
            }
        } catch (e) {
            console.error('[players] flush failed:', e.message);
        } finally {
            this._flushing = false;
            if (this._flushAgain) { this._flushAgain = false; this.save(); }
        }
    }
}

module.exports = Players;
