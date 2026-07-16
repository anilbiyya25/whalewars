'use strict';

const CFG = require('./config');

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const NAMES = ['CryptoKing', 'Volt_Sniper', 'Vegas_VIP', 'Matrx_0', 'Shredder', 'GamerX',
    'Alpha_Red', 'MoonShot', 'DeFiDegen', 'BluePhantom', 'RedBaron', 'TiltMaster',
    'Kraken88', 'NeonWolf', 'StackDaddy', 'ZeroFear', 'GoldRush_7', 'PixelShark'];

const CHAT = {
    betting: [
        ['red', 'Red army assemble, easy money this round'],
        ['blue', 'Blue pool already stacking, join the winners'],
        ['red', 'Pumping my whole balance into RED'],
        ['blue', 'Red bettors donating again lol'],
    ],
    redWinning: [
        ['red', 'RED IS UNSTOPPABLE 🔥'],
        ['blue', 'Blue whales where are you?? SAVE US'],
        ['red', 'Cashing at 5x, printing money'],
        ['blue', 'Boosting blue NOW, everyone push'],
    ],
    blueWinning: [
        ['blue', 'BLUE WALL. Nothing gets through 🧊'],
        ['red', 'We need a red whale ASAP'],
        ['blue', 'Watch the multiplier climb boys'],
        ['red', 'Everyone dump into red, we can flip this'],
    ],
};

function botAmount() {
    const r = Math.random();
    if (r < 0.55) return Math.floor(rand(50, 600));
    if (r < 0.82) return Math.floor(rand(600, 2500));
    if (r < 0.95) return Math.floor(rand(2500, CFG.WHALE_MIN));
    return Math.floor(rand(CFG.WHALE_MIN, 45000)); // whale
}

/**
 * Simulated liquidity so a solo tester still sees a live, contested arena.
 * Bots inject pool money and chat; they never receive payouts.
 */
function attachBots(engine) {
    setInterval(() => {
        const r = engine.round;

        if (r.phase === 'betting') {
            if (Math.random() < 0.55) placeBet(false);
            if (Math.random() < 0.09) chat();
        } else if (r.phase === 'live') {
            if (Math.random() < 0.22) placeBet(true);
            if (Math.random() < 0.10) chat();
        }

        function placeBet(live) {
            const amt = botAmount();
            // comeback drama: live money slightly favors the losing side
            let team;
            if (live && r.pos !== 50 && Math.random() < 0.58) {
                team = r.pos < 50 ? 'blue' : 'red';
            } else {
                team = Math.random() < 0.5 ? 'red' : 'blue';
            }
            const name = pick(NAMES) + '_' + Math.floor(rand(10, 99));
            engine.systemBet(name, team, amt);
        }

        function chat() {
            let pool = CHAT.betting;
            if (r.phase === 'live') pool = r.pos < 50 ? CHAT.redWinning : CHAT.blueWinning;
            const [team, text] = pick(pool);
            engine.systemChat(text, pick(NAMES), team);
        }
    }, 250);
}

module.exports = attachBots;
