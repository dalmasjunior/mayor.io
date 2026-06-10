# Deploy CIDADE.io — Go Live in ~10 Minutes

This guide takes the CIDADE.io MVP from your computer to a public URL your friends
can open in a browser. It is written for a non-expert. Pick **one** platform —
**Render** or **Railway**. Both support the realtime WebSocket connection the game needs.

> **What only YOU can do:** Creating accounts and logging in (GitHub, Render, Railway)
> requires your own email/login. An assistant cannot do that part for you. This guide
> tells you exactly what to click and run.

---

## 0. One-time prep (about 2 minutes)

The app is a Node.js + Express + Socket.io server that serves the game client from
`public/` on the same address. No database, no extra services.

You need:

- A **GitHub** account — https://github.com (free).
- The project folder `cidade-mvp/` on your computer.

Make sure `node_modules` is **NOT** committed to git. It is large, machine-specific,
and the hosting platform reinstalls it from `package.json`. The included `.gitignore`
already excludes `node_modules` and `.env`, so you are covered — just don't force-add them.

### Push the project to GitHub

If the folder is not yet a git repo, run these in a terminal inside `cidade-mvp/`:

```bash
git init
git add .
git commit -m "CIDADE.io MVP"
```

Then create an empty repo on GitHub (the "New repository" button — do NOT add a README),
and connect + push (replace the URL with the one GitHub shows you):

```bash
git remote add origin https://github.com/YOUR_USERNAME/cidade-mvp.git
git branch -M main
git push -u origin main
```

Verify on github.com that you can see `server.js`, `package.json`, and the `public/`
folder — but **not** a `node_modules` folder.

---

## Option A — Render (recommended for "set it and forget it")

### A1. GitHub flow (easiest — no command line)

1. Go to https://render.com and **Sign up / Log in** (you can log in with GitHub).
2. Click **New +** → **Blueprint** (this repo includes a `render.yaml`, so Render
   configures everything automatically).
   - If you prefer manual setup, choose **New +** → **Web Service** instead, pick your
     repo, and set: **Build Command** = `npm install`, **Start Command** = `npm start`,
     **Health Check Path** = `/health`.
3. Connect your GitHub account and select the `cidade-mvp` repository.
4. Render reads `render.yaml`: Node web service, free plan, build `npm install`,
   start `npm start`, health check `/health`. Click **Apply** / **Create**.
5. Wait for the build + deploy to finish (~1–3 minutes). You'll get a URL like
   `https://cidade-mvp.onrender.com`.

### A2. CLI flow (alternative)

Render's primary flow is the dashboard above. If you want CLI:

```bash
# Install the Render CLI (macOS/Linux):
brew install render    # or see https://render.com/docs/cli
render login
render blueprint launch   # deploys using render.yaml from the repo
```

### A3. Caveat to know (important for "friends testing today")

The **free** Render web service **sleeps after ~15 minutes of inactivity**. The first
visitor after it sleeps waits ~30–60 seconds for a **cold start**, then it's fast again.
For a smoother test session, tell friends to hit the link, give it up to a minute the
first time, or upgrade to the **Starter** paid plan (no sleeping) — change `plan: free`
to `plan: starter` in `render.yaml`.

---

## Option B — Railway (recommended for fast, no-sleep trial)

### B1. GitHub flow (easiest)

1. Go to https://railway.app and **Log in** (you can log in with GitHub).
2. Click **New Project** → **Deploy from GitHub repo** and select `cidade-mvp`.
3. Railway detects Node automatically and uses the included `railway.json`
   (start command `node server.js`, health check `/health`). It also reads the
   `Procfile` (`web: node server.js`).
4. After the first deploy, open **Settings → Networking → Generate Domain** to get a
   public URL like `https://cidade-mvp-production.up.railway.app`.
5. Wait for the deploy to go green (~1–2 minutes), then open the URL.

### B2. CLI flow (alternative)

```bash
# Install the Railway CLI:
npm i -g @railway/cli       # or: brew install railway
railway login
railway init                # link/create a project
railway up                  # build & deploy the current folder
railway domain              # generate a public URL
```

### B3. Caveat to know

Railway runs on **trial credits** (a small monthly free allowance). It does **not**
sleep on idle, so cold starts aren't an issue, but once the trial credit runs out the
service stops until you add a paid plan. Great for a focused testing day; check your
usage in the dashboard.

---

## Environment variables

You normally do **not** need to set anything. Defaults are baked in.

| Variable        | Set it?                | Notes                                                        |
| --------------- | ---------------------- | ------------------------------------------------------------ |
| `PORT`          | **No** — auto-injected | The platform provides it. The server reads `process.env.PORT`. |
| `HOST`          | No                     | Defaults to `0.0.0.0` (required by these platforms).         |
| `NODE_ENV`      | Optional               | Set to `production` (already in `render.yaml`).              |
| `ROUND_PLAY_MS` | Optional               | Playing time between elections, ms. Default `70000`.         |
| `MATCH_MS`      | Optional               | Total match length, ms. Default `360000` (6 min).            |
| `XP_BASE`       | Optional               | XP needed for level 2. Default `30`.                         |

To set an optional var: in **Render** use the service's **Environment** tab; in
**Railway** use the **Variables** tab. See `.env.example` for the full list.

---

## Verify it's live (30 seconds)

1. Open your public URL in a browser. The CIDADE.io lobby should load (HTTP 200).
2. Health check: open `https://YOUR-URL/health` — it should return
   `{"status":"ok", ...}`.
3. Realtime test: open the URL in **two** browser tabs (or two devices).
   - In tab 1, **create a room** and note the 5-letter code.
   - In tab 2, **join** with that code.
   - Both players should appear in the same lobby; start the match and confirm you
     can see each other moving. That confirms WebSockets work end-to-end.

---

## Custom domain — the `.io` idea (optional)

Using a real `cidade.io`-style domain is a nice touch but **not required** to test today.

- Buy the domain from any registrar (`.io` domains are pricier than `.com`).
- **Render:** Service → **Settings → Custom Domains** → add your domain, then create the
  CNAME/A record your registrar requires.
- **Railway:** Service → **Settings → Networking → Custom Domain** → add it and set the
  CNAME at your registrar.
- HTTPS certificates are issued automatically by both platforms once DNS verifies.

Skip this for the first friends-test; the free platform URL works fine.

---

## Troubleshooting

- **App won't start / "no open ports detected":** confirm the start command is
  `npm start` (Render) or `node server.js` (Railway), and that you did **not** hard-code
  a port — the server already uses `process.env.PORT`.
- **502 / blank page right after deploy:** wait for the build to finish; on Render free,
  the first hit after idle is a cold start (~1 min).
- **Friends can't connect in realtime:** make sure they use the `https://` URL the
  platform gave you (not `http://localhost`). WebSockets are enabled on both platforms
  by default.
- **node_modules got committed:** remove it from git with
  `git rm -r --cached node_modules && git commit -m "drop node_modules"` and push again.
