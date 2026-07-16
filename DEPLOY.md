# Deploying Whale Wars (free demo)

This guide gets Whale Wars online for **free** so real people can play it from a link.
Recommended host: **Render** — no credit card required, supports WebSockets.

---

## First, the honest expectations

| | Free tier (Render) | What you need for 1000 live |
|---|---|---|
| Cost | $0, no card | ~$5–10/month |
| Always on? | ❌ sleeps after 15 min idle (≈30s cold start on next visit) | ✅ always on |
| Realistic capacity | ~100–300 players before lag | ~1000+ |
| Data survives redeploy? | ❌ disk is wiped (balances reset) | ✅ with an external database |

**Your server code is not the bottleneck.** A load test showed 645 concurrent
connections using only ~113 MB of RAM with zero drops and ~130 ms action latency.
The limits above come from the *free host* (shared CPU, sleep policy, wiped disk),
not the game. When you outgrow free, you move the same code to a paid box — see the
last section.

Use the free deploy to **test with real users and share a link**. Don't announce it
to 1000 people at once.

---

## Deploy to Render (≈15 minutes)

You need two free accounts: **GitHub** (to hold the code) and **Render** (to run it).

### Step 1 — Put the code on GitHub

Install Git if you don't have it: https://git-scm.com/download/win

Then, in this project folder, run these commands one at a time (Git Bash or terminal):

```bash
git init
git add .
git commit -m "Whale Wars"
```

Create an empty repository on GitHub:
1. Go to https://github.com/new
2. Name it `whalewars`, keep it **Public** (or Private — both work), **don't** add a README.
3. Click **Create repository**.

GitHub then shows a "…or push an existing repository" box. Copy the two lines it gives
you and run them — they look like:

```bash
git remote add origin https://github.com/YOUR-NAME/whalewars.git
git branch -M main
git push -u origin main
```

Your code is now on GitHub.

### Step 2 — Create the Render service

1. Sign up at https://render.com (log in with GitHub — easiest).
2. Click **New → Web Service**.
3. Connect your `whalewars` GitHub repo.
4. Render reads `render.yaml` in the repo and fills everything in. If it asks manually:
   - **Runtime:** Node
   - **Build command:** `npm ci --omit=dev`
   - **Start command:** `node server/index.js`
   - **Instance type:** Free
   - **Health check path:** `/healthz`
5. Click **Create Web Service** and wait ~2–3 minutes for the first build.

### Step 3 — Share the link

Render gives you a URL like `https://whalewars.onrender.com`. Open it — that's the game.
Send that link to your players. Done.

> First visit after it's been idle takes ~30 seconds to wake up. That's the free tier.

---

## Settings you can change (Render → your service → Environment)

| Variable | Default | What it does |
|---|---|---|
| `SUPABASE_URL` | — | Your Supabase project URL (Settings → API). Enables durable storage + leaderboard. |
| `SUPABASE_SERVICE_KEY` | — | Supabase `service_role` secret key. **Keep secret** — set it in the dashboard, never in code. |
| `BOTS` | on | Set to `0` to turn off simulated players once you have real traffic |
| `CORS_ORIGIN` | `*` | Set to your site URL to lock down who can connect |
| `NODE_VERSION` | `22` | Node version Render builds with |

**Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in Render** (Environment tab) so player
balances and the leaderboard survive redeploys. Without them, the app still runs but
falls back to a local file that gets wiped on each deploy. After changing an env var,
Render redeploys automatically.

---

## Checking it's healthy

- `https://your-app.onrender.com/healthz` → should say `ok`
- `https://your-app.onrender.com/stats` → live JSON: connections, memory, current round

---

## When you outgrow the free tier

You'll know it's time when: the sleep/cold-start annoys players, or you approach a few
hundred concurrent. Then, in order:

1. **Upgrade the instance** — Render's paid instances (from ~$7/mo) are always-on with
   dedicated CPU. Same code, one click. Alternatively a $5 VPS (Hetzner, DigitalOcean)
   or a paid Fly.io machine.
2. **Add a real database** — free hosting wipes the disk on redeploy, so player balances
   reset. To make them permanent, use a free managed database (Neon or Supabase for
   Postgres, Upstash for Redis) and replace the JSON storage in
   [`server/players.js`](server/players.js). That file is deliberately the only place
   money is stored, so it's a contained change.
3. **Scale past ~3000 concurrent** — run multiple instances behind the Socket.IO Redis
   adapter, with the game loop as its own single process. Not needed before then.

## Re-running the load test yourself

```bash
npm install                 # installs the test client (dev dependency)
node tools/loadtest.js 300 http://localhost:3000 25
# or point it at your deployed URL:
node tools/loadtest.js 200 https://your-app.onrender.com 25
```
