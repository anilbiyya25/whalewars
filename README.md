# 🐋 Whale Wars — MVP

Asymmetric multiplayer whale tug-of-war. Two global teams (Red vs Blue) of whales bet
against each other's pool weight to drag a shared rope; the winning side's multiplier
compounds while the losing side's collapses to 0x. Cash out at any moment mid-battle.

**Server-authoritative:** all money movement (balances, pools, multipliers, settlement)
happens on the Node server. Clients only send intents and render broadcast state.

## Run it

```bash
npm install
npm start
```

Open **http://localhost:3000** — then open a second browser tab (or another device on your
LAN) to see real multiplayer: both clients fight over the same rope in the same round.

- `npm run dev` — auto-restart on file changes
- `BOTS=0 npm start` — disable simulated liquidity (bots)
- `PORT=8080 npm start` — change port

## Round timeline (45s loop)

| Phase | Duration | What happens |
|---|---|---|
| Betting | 10s | Players stake coins and lock a team. Live pari-mutuel odds shown. You may **cancel** your bet (full refund) during this window only. |
| Live Battle | 35s | Rope physics run off the live pool ratio. Boosts and whale bets (🪙5,000+) apply kinetic impulses. Odds update as money flows: the team with **less** money pays **more**. |
| Settlement | 6s | Whichever side the rope is on wins. The whole net pool (total − 4% house edge) is split among the winning team's backers **pro-rata by stake**. Losing team's stakes fund the prizes. |

## Economy — pari-mutuel pool, 100% virtual coins (🪙)

No real money anywhere. New players get **🪙10,000 free**; bets are whole coins
(min 🪙10, max 🪙100,000); a free-coin refill unlocks when your balance drops
under 🪙500.

**Pari-mutuel math** (see [`server/engine.js`](server/engine.js)): a team's multiplier
is `net pool ÷ that team's pool`, where the net pool is the total minus a **4% house
edge**. Winners split exactly the net pool in proportion to their stake, so the house
keeps precisely 4% every round and **payout liability is always bounded by the pool** —
no runaway exposure. There is intentionally **no mid-round cashout**: under pool odds it
would let an underdog bettor drain the pot. (If you want an Aviator-style cashout back,
that requires a capped-multiplier model instead of a pool.)

## Architecture

```
server/
  config.js    — all tunables (timings, edge, whale threshold, bet limits)
  engine.js    — round state machine, rope physics, multiplier math, settlement
  players.js   — player registry + JSON persistence (data/players.json)
  bots.js      — simulated liquidity & chat (dev/demo only)
  index.js     — Express static host + Socket.IO intent handlers
public/
  index.html / style.css / client.js — thin rendering client
```

**Protocol** (Socket.IO):

- Client → server: `auth {token?, name}`, `bet {team, amount}`, `boost {amount}`,
  `cancel`, `refill`, `chat {text}` — all money intents answered with acks
  (`{ok, balance, position}` or `{error}`).
- Server → clients: `state` (10Hz snapshot), `phase`, `feed:bet`, `whale`, `chat`,
  `round:new`, `round:end` (personalized settlement per socket), `online`, `hello` (config).

Identity is a `crypto.randomUUID()` token stored in the browser's localStorage —
balance survives refreshes and reconnects mid-round restore your open position.

## What this MVP is NOT (yet)

This runs on **virtual coins**. If it ever moves to real money, you need — in roughly this order:

1. **Real auth + database** — replace the localStorage token / JSON file with accounts
   in Postgres, and a ledger table (every debit/credit as an immutable row).
2. **Provable fairness** — the rope noise uses `Math.random()`. Real-money games like this use a
   committed server seed + client seeds (hash published before the round).
3. **Liability management** — ✅ already handled: the pari-mutuel model bounds house
   exposure to the pool and locks in a 4% margin every round (winners can only split
   what losers put in). Nothing to change here for the money model itself.
4. **Licensing / KYC / AML / payments** — jurisdiction licensing, then a PSP or crypto
   custody integration. This is the long pole for any B2B iGaming deployment.
5. **Scale-out** — single-process room today. Multi-node needs the Socket.IO Redis
   adapter and the engine extracted into its own service (one authoritative loop).
6. **Anti-abuse** — per-IP connection caps, bet rate limits, idempotency keys on intents.

## Tuning knobs (server/config.js)

- `HOUSE_EDGE` — 0.035 (3.5% skim on every payout)
- `WHALE_MIN` — $500 alert threshold
- Multiplier curve — `_stepMults()` in engine.js (`dom * 0.0095` growth per 100ms tick;
  raise/lower to change how fast dominance pays)
- Rope feel — spring `0.045`, damping `0.88`, impulse scale in `_impulse()`
