'use strict';

module.exports = {
    PORT: process.env.PORT || 3000,

    // Round timeline (45s loop per spec: 10s lobby + 35s battle)
    BET_SECS: 10,
    LIVE_SECS: 35,
    SETTLE_SECS: 6,
    TICK_MS: 100,

    // Economy — virtual coins (🪙), integers only, no real money
    HOUSE_EDGE: 0.04,         // 4% skim on every payout
    MAX_MULT: 10.0,           // multiplier cap — bounds house liability (payout ≤ MAX_MULT × stake)
    WHALE_MIN: 5000,          // coin threshold that triggers a global whale alert
    START_BALANCE: 10000,     // free coins for new players
    MIN_BET: 10,
    MAX_BET: 100000,
    REFILL_BELOW: 500,        // free-coin refill allowed under this balance
    REFILL_AMOUNT: 10000,

    // Rope physics bounds (percent along the track)
    ROPE_MIN: 4,
    ROPE_MAX: 96,

    // Simulated liquidity so a solo player still sees a live arena.
    // Turn off when you have real concurrent traffic.
    BOTS: process.env.BOTS !== '0',
};
