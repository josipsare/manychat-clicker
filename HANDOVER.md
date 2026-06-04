# Handover: ManyChat Clicker

Welcome. This document brings you up to speed on the project I'm handing over. Read this end-to-end before touching anything. After this, `OPERATIONS.md` is your day-to-day reference.

Estimated reading time: 25–40 minutes.

---

## 1. What this project is

A small system that **automates ManyChat's web UI to send follow-up messages**. n8n workflows call our HTTP endpoint with a chat ID, page ID, and message; our system opens ManyChat in a real browser (Playwright), types the message, and clicks Send. It looks like a human did it.

### Why a browser, not the ManyChat API?

ManyChat's official API has restrictions that don't fit our use case (rate limits, message types, follow-up window rules). Driving the UI gives us full flexibility — anything a human can do, we can do.

The trade-off is that we're driving a real browser with Playwright, so each "send" takes 20–35 seconds of real Chromium work and we have to think about concurrency, headless detection, session persistence, and ManyChat's UI changing under us.

### Two kinds of requests

1. **Text follow-ups** (`type: "text"`) — open chat, type the message, click "Send to Instagram", click the timer button, click "Resume automations" in the dropdown.
2. **Automation triggers** (`type: "automation"`) — open chat, click the Automation button, search for the automation by name, click it, click "Pick This Automation".

Both flows live in `server.js` inside the `handlePress(...)` function.

---

## 2. Business context (what you should know)

- The agency runs multiple clients on ManyChat. **All clients are managed under a single ManyChat account** that has access to every client's pages. So there is exactly **one ManyChat login session** that we keep alive.
- Each "client" corresponds to a `pageId` (the Instagram page in ManyChat). The system can have 100+ pageIds active.
- **n8n is the orchestrator.** It decides when to send follow-ups, retries on failure, and listens for our outcome webhook. We are the dumb (but reliable) sender.
- n8n's HTTP Request node calls `https://manychat-followupsv2.setty.ai/press` and **blocks until the message is actually sent or fails**. n8n's workflow uses this synchronous behavior as a natural rate-limit: the next follow-up for a client doesn't fire until the previous one finishes. **Don't break this.** Any change that makes our endpoint return early would silently break n8n's rate-limiting model.

---

## 3. System architecture (current state)

```
                          ┌──────┐
                          │ n8n  │  (workflows)
                          └──┬───┘
                             │ POST https://manychat-followupsv2.setty.ai/press
                             ▼
                     ┌──────────────────┐
                     │  Cloudflare DNS  │  proxied, routes to a tunnel
                     └──────┬───────────┘
                            ▼
                     ┌────────────────┐
                     │  Router VPS    │  Ubuntu, 45.63.119.187
                     │  /opt/router/  │  Node + PM2 + cloudflared
                     │  router.js     │  listens on localhost:8080
                     └────────┬───────┘
        Least-loaded + affinity│
                            ▼
                     ┌────────────────┐
                     │  Master VPS    │  Windows, 192.248.176.79
                     │  server.js     │  listens on localhost:3000
                     │  Playwright    │  ManyChat session lives here
                     └────────┬───────┘
                              ▼
                     ┌────────────────┐
                     │  ManyChat web  │  app.manychat.com
                     └────────────────┘
```

Today we have **one backend** (the master VPS). The router sits in front of it. The architecture is ready to handle multiple backends — Phase 3 (adding workers) is a near-trivial config change away.

### Why a router at all if there's only one backend today?

So we can add backends later **without changing anything in n8n or DNS**. n8n will keep hitting the same URL forever, regardless of how many backends are behind the router. This was the explicit design goal — n8n is sacred, never touch it.

---

## 4. The journey — what we've already built

The system started as a single VPS running `server.js`. Over time we hit problems and fixed them in phases.

### Original system (legacy, ~Oct 2025)

One Windows VPS running `server.js`. n8n called Cloudflare → tunnel → `localhost:3000`. Worked, but:
- Single point of failure (one process crash = everything down)
- Duplicate sends from n8n retries (n8n times out, retries, original eventually completes, retry also completes → two messages sent)
- No visibility (when something went wrong, we didn't know unless n8n reported it)
- Single concurrency ceiling (8 parallel Playwright tabs max)

### Phase 1 — Reliability and observability (May 2026)

Made the single backend bulletproof and observable. **Already deployed on the master VPS.**

- **Crash guards**: `process.on('uncaughtException')` and `'unhandledRejection')`. The process never dies from Playwright errors. Individual `/press` requests can fail, the process stays up.
- **Deduplication**: server-side memory of every request's fingerprint (SHA-1 of `type|chatId|pageId|message|automation_name`). Identical retries within 10 minutes are blocked. Only requests where we *actually sent* the message are cached, so genuine recovery retries still work.
- **`slowType` Enter tracking**: in ManyChat, typing `\n` triggers Enter which sends the message. If our typing fails partway through but we already typed past a `\n`, the message was already sent — we mark it as sent and cache the dedup entry. This was a real bug we hit.
- **Slack alerts**: any uncaught crash or blocked dedup fires a JSON webhook to the n8n FUs-logs workflow with `event: "crash"` or `event: "dedup-blocked"`. n8n routes those to Slack.
- **Code review fixes**: several pre-existing bugs in admin endpoints (`/debug-verify-login`, `/get-session` page leak, etc.).

See `server.js` from line 1 onward for the changes. Key landmarks:
- Lines 7–55: crash guards + crash notification function
- Lines 58–102: dedup-blocked notification (separate event type)
- Lines 136–174: dedup map + helpers
- Lines 1100s: `handlePress` with `sent: true/false` on every return path
- Lines 1990s+: `/get-session` endpoint with Bearer auth

### Phase 2 — Load balancing (May 2026, just completed)

Added the router VPS and migrated production traffic to it. **Already cutover.**

- **Router VPS** (Ubuntu, 45.63.119.187) runs `router.js` on port 8080.
- **Cloudflare tunnels**: kept the existing tunnel on master (`manychat-clicker`) for the master, added a new tunnel on router (`manychat-router`) for the router. The production URL's route was moved from one tunnel to the other.
- **Internal URL**: `https://manychat-backend.setty.ai` is a new public hostname that points at the master via the existing tunnel. The router uses this to reach the master.
- **Routing logic**: when a request arrives, the router checks the affinity cache. If this exact request fingerprint went somewhere in the last 10 minutes, send it back to that same backend (preserves dedup). Otherwise, send it to the backend with the fewest in-flight requests.
- **Cookie sync infrastructure** (idle today, used in Phase 3): `server.js` has a `COOKIE_SYNC_MASTER_URL` env var. If set, that VPS becomes a worker that pulls cookies from the URL every 30 minutes. The master itself does NOT have this var set, so it remains the source.
- **Earlier design (sticky pageId, spillover) was scrapped** during the Phase 2 walkthrough after discussion with the user. The current design is "pure least-loaded with affinity-preserved dedup" — simpler, no client caps, no concept of one client being "owned by" one server. Every request goes to whichever backend is least busy at that moment.

See `router/router.js` for the implementation.

### Phase 3 — Adding workers (not done yet)

When the master's concurrency (8) becomes a bottleneck, spin up additional worker VPSs. They pull cookies from the master via `COOKIE_SYNC_MASTER_URL=https://manychat-backend.setty.ai`. Once running, add their URL to `BACKENDS=` in the router's `.env` and restart the router. That's it — no DNS, no n8n, no master changes.

Detailed step-by-step lives in `OPERATIONS.md` under "Phase 3 — Adding a worker backend".

---

## 5. Repository structure

```
manychat-clicker/
├── server.js                      ← Backend code (master + future workers run this)
├── package.json                   ← server.js dependencies
├── .env.example                   ← Template for backend .env
├── HANDOVER.md                    ← This file
├── OPERATIONS.md                  ← Day-to-day reference, runbook, scaling guide
├── README-DEPLOYMENT.md           ← Older deployment doc, partially superseded by OPERATIONS.md
├── DEPLOYMENT-SIMPLE.md           ← Older, basic deployment notes
├── VULTR-PRODUCTION-GUIDE.md      ← Original Vultr setup notes for the master VPS
├── ANTI-FLAGGING-VPS.md           ← Notes on staying under ManyChat's detection radar
├── TESTING-GUIDE.md               ← Manual test recipes
├── router/                        ← Phase 2 router app (separate Node project)
│   ├── router.js
│   ├── package.json
│   └── .env.example
├── data/                          ← Playwright user-data (cookies, etc.). Gitignored.
├── node_modules/                  ← Gitignored.
├── *.ps1                          ← PowerShell helpers (start scripts, tunnel setup)
├── extract-session.js             ← Helper for migrating session between machines
├── manual-login.js                ← One-off helper for first-time login
└── stress-test-8-parallel.js      ← Concurrency test script
```

**The two files that actually run in production**: `server.js` and `router/router.js`. Everything else is supporting material, history, or one-off scripts.

---

## 6. Key files and what they do

### `server.js` (the backend)

A single Express app with one heavy worker (`handlePress`) wrapped in a PQueue. Routes:

| Route | Purpose |
|---|---|
| `POST /press` | The main entry point. n8n (via router) calls this. Dedup → queue → Playwright → response. |
| `GET /healthz` | Liveness probe (used by the router). |
| `GET /init-login` | One-time bootstrap: opens a non-headless browser so a human can log into ManyChat. |
| `GET /confirm-login` | Verify the saved session is logged in. |
| `GET /get-session` | Returns cookies + localStorage. Used by workers in Phase 3 to inherit the master's session. Requires Bearer auth. |
| `POST /transfer-session` | Accepts cookies + localStorage and applies them. Used during master rotation. |
| `POST /upload-user-data` | Accepts a base64 zip of the entire Chromium user-data folder. Initial deployment helper. |
| `GET /debug-session`, `POST /debug-verify-login`, `GET /dedup-status` | Diagnostics. |
| `POST /test-crash-notification`, `POST /test-dedup-notification` | Force-trigger the Slack alerts for testing. |
| `POST /sync-pool`, `POST /reinit-pool`, `POST /sync-from-master` | Various session-sync triggers. |

The Playwright work happens inside `handlePress`. It opens the chat URL, dismisses pop-ups (ManyChat shows upsell modals constantly), finds the message composer, types slowly with jitter (`slowType`), clicks "Send to Instagram" (or runs the automation flow), then does the "timer + Resume automations" sequence at the end. It's defensive — every selector has fallbacks; if something doesn't match, we treat it as "didn't send" and return `sent: false`.

### `router/router.js` (the load balancer)

Much simpler than `server.js`. Express app that:

1. Reads the `pageId` from the request body
2. Computes the dedup key (same formula as the backend)
3. Looks up the affinity cache: have we seen this exact request before?
4. If yes, forward to the same backend
5. If no, pick the backend with the fewest in-flight requests
6. Forward and stream the response back

Routes:

| Route | Purpose |
|---|---|
| `GET /healthz` | Lightweight liveness probe. |
| `GET /status` | Backend health, in-flight counts, affinity cache size. Use this to see what the router is doing. |
| `POST /press` | Main route. Forwards to a backend. Blocks until the backend responds (sync proxy). |
| `*` (catch-all) | Forwards any other path to the first healthy backend. Useful for `/dedup-status`, `/get-session`, etc. on backends. |

Critical detail: the proxy is **fully synchronous**. n8n's request stays open until the backend completes its work and returns. This preserves n8n's per-client rate-limit model. **Don't change this to async.**

### `.env` files

These are **per-machine** and gitignored. Template versions live as `.env.example` in the repo.

The master's `.env` has things like `AUTH_TOKEN`, `USE_SINGLE_CONTEXT=true`, `SINGLE_CONTEXT_MAX_TABS=8`, `FOLLOWUP_LOG_WEBHOOK_URL=https://n8n.setty.ai/webhook/FUs-logs`.

The router's `.env` has `PORT=8080`, `BACKENDS=https://manychat-backend.setty.ai`, plus health-check tuning.

Full env var reference is in `OPERATIONS.md` (Environment variable reference section).

---

## 7. Critical tribal knowledge

Things that aren't obvious from the code but you'll need to know.

### The ManyChat session is precious

It lives in `data/user-data/` on the master VPS (Playwright's persistent context). If that folder gets corrupted, deleted, or the session expires and nobody re-logs in, **the whole system stops working** because nobody can send messages.

How to recover: RDP into the master, run `server.js` with `HEADLESS=false`, browse to manychat.com, log in manually. Restart `server.js` with `HEADLESS=true`. Future workers (Phase 3+) will pick up fresh cookies on their next sync.

How to back up: zip `data/user-data/` periodically and store somewhere safe. Restore by unzipping and restarting.

### `\n` in a message means "send"

The `slowType` function types each character with jitter. When it hits `\n`, Playwright's `locator.type('\n')` interprets that as the Enter key — which in ManyChat means **send the message**.

We use this deliberately. n8n workflows can include `\n` to trigger Enter. The flip side: if typing fails partway through and you've already typed past a `\n`, the message IS sent. The code tracks this via a `state.enterPressed` flag passed to `slowType`. Returns `sent: true` in that case so dedup caches it.

Don't "fix" the `\n` behavior to use Shift+Enter or strip newlines. It's intentional.

### The dedup key is sensitive

It's `sha1(type|chatId|pageId|message|automation_name)`. **The router and backend both compute this independently and must agree** — if they disagree, an n8n retry could route to a different backend than the original, dedup wouldn't catch it, and we'd send a duplicate.

If you change the dedup key formula, change it in **both** `server.js` and `router/router.js` at the same time.

### Sync wait between router and backend

n8n times out after some number of seconds (depends on the workflow). If the backend's `JOB_TIMEOUT_MS` is 7 min, and the router's `PROXY_TIMEOUT_MS` is 10 min, and n8n's timeout is shorter than either — n8n gives up first, retries, and dedup catches the retry. This is the design.

Don't shorten `PROXY_TIMEOUT_MS` to less than the backend's `JOB_TIMEOUT_MS` — that would cause spurious 504s from the router.

### Pop-up dismissal can trigger navigation

ManyChat occasionally redirects when you click a modal close button. The `dismissPopups` function in `server.js` wraps the click in `Promise.all([click, waitForLoadState])` so a click that triggers navigation doesn't throw an unhandled timeout. **This crashed the original process** before Phase 1. Don't simplify this back to a bare click.

### One ManyChat account, multiple human sessions

Colleagues log into the same ManyChat account from their own browsers while our system is running. This **doesn't** cause flagging in practice — the user explicitly tested this assumption. Multiple browsers from multiple IPs on the same account is tolerated. This is why we don't sticky-route by pageId.

### `SINGLE_CONTEXT_MAX_TABS=8` on master

Default in code is 4. Master VPS has it set to 8 in its `.env`. Confirmed by RDP-ing in and watching 8 windows open during a burst test.

### Stagger delay

Backend has `STAGGER_DELAY_MS=2500`. Each `/press` waits a random 0–2.5 seconds before actually starting. Helps with the "many requests at the same instant" pattern look less robotic.

### Cookie sync direction

In Phase 3, workers pull *from* master. Master never pushes. If master is down, new workers can't bootstrap (existing workers run on whatever cookies they had). This is documented in OPERATIONS.md under "Known limitations".

### The router's affinity cache is per-process

If the router VPS restarts, the affinity cache is gone. Retries that came in before the restart might land on a different backend than their original. This is fine in single-backend mode (there's only one place to go). When you scale to multiple backends, it becomes a theoretical risk — but only for in-flight requests during a router restart, which is a tiny window.

---

## 8. Day 1 — getting oriented

1. **Read this file in full.** You're doing that now.
2. **Read `OPERATIONS.md` in full.** It's the day-to-day reference.
3. **Clone the repo locally.** It's at https://github.com/josipsare/manychat-clicker.
4. **Get SSH access to the router VPS** (45.63.119.187). Ask Josip for the SSH key or credentials.
5. **Get RDP access to the master VPS** (192.248.176.79). Ask Josip.
6. **Get access to Cloudflare's dashboard** for the setty.ai zone (Zero Trust → Networks → Tunnels).
7. **Get access to the n8n instance** at n8n.setty.ai. Specifically the FUs-logs webhook workflow and any follow-up workflows that call our `/press` endpoint.
8. **Get access to the Slack channel** where crash and dedup alerts land.

### Verify everything works for you

```bash
# From your laptop:
curl -i https://manychat-followupsv2.setty.ai/healthz
# Expect 200 OK with {"ok":true,"healthyBackends":1,"totalBackends":1}

# SSH into router:
ssh root@45.63.119.187
pm2 status                          # Should show "router" online
pm2 logs router                     # Watch live traffic
curl http://localhost:8080/status   # See backend health and in-flight counts
```

```powershell
# RDP into master, open PowerShell:
# Open the project folder
# Look at the console running node server.js
# Or hit http://localhost:3000/healthz
```

### Verify Slack alerts work for you

```bash
# From router VPS (so you have AUTH_TOKEN handy):
curl -X POST https://manychat-followupsv2.setty.ai/test-crash-notification \
  -H "Authorization: Bearer <AUTH_TOKEN>"
```

You should see a Slack message land in the alert channel with `[CRASH on ...]`.

---

## 9. Common tasks (what you'll actually do)

### "n8n is reporting failed workflow executions"

1. `pm2 logs router` — is the router forwarding correctly? Are you seeing 502s?
2. `curl http://localhost:8080/status` — is the backend healthy?
3. If backend is unhealthy: RDP into master, check `node server.js` is running, check ManyChat session isn't expired.
4. If backend is healthy but slow: check if you're hitting the concurrency limit. Time for Phase 3?

### "ManyChat session expired"

1. RDP into master VPS.
2. Stop `node server.js`.
3. Start it with `HEADLESS=false` (edit `.env` or set env var inline).
4. A browser window opens. Log into ManyChat manually.
5. Stop `node server.js`.
6. Restart with `HEADLESS=true`.

The session is persisted in `data/user-data/` and will work going forward.

### "ManyChat changed their UI and the bot is sending failed"

Symptoms: lots of `/press` requests returning `sent: false` because composer not found, send button not found, etc.

1. SSH into master and tail logs: `pm2 logs` or similar.
2. Look at the screenshots in `data/` folder — `chat-page-error.png`, `send-button-error.png` etc. are saved automatically on failures.
3. Look at the actual ManyChat page in a real browser. What changed?
4. Update the selector arrays in `server.js` (most are arrays of candidate selectors that fall through).
5. Test the change locally with `HEADLESS=false` and a single request.
6. Paste new `server.js` onto the master and restart.

### "Need to add a worker (Phase 3)"

`OPERATIONS.md` → "Phase 3 — Adding a worker backend" → 10-step playbook. Roughly 30–45 minutes.

### "Need to update the router code"

1. Edit `router/router.js` locally.
2. SSH into router VPS, `cd /opt/router`, `nano router.js`, paste, save.
3. `pm2 restart router`.
4. `pm2 logs router --lines 20` — confirm startup banner.

### "Need to update the backend code"

1. Edit `server.js` locally.
2. RDP into master, open the project folder, replace `server.js` content.
3. Stop and restart `node server.js`.
4. Watch logs for errors during startup.
5. Hit `/healthz` to verify.

### "Need to roll back something"

`OPERATIONS.md` → "Rollback procedures". Three sections: full Phase 2 rollback, Phase 3 worker rollback, code change rollback.

---

## 10. Things to be careful about

- **Don't change the dedup key formula on only one side.** Both `server.js` and `router/router.js` must agree.
- **Don't change `PROXY_TIMEOUT_MS` to less than backend's `JOB_TIMEOUT_MS`.** Causes spurious 504s.
- **Don't make the router async.** It must block until the backend responds. n8n relies on this.
- **Don't strip `\n` from messages.** It's how some workflows trigger Enter.
- **Don't delete `data/user-data/` on master without re-logging in first.**
- **Don't commit `.env` files** (gitignored, but be careful with manual git add).
- **Don't expose `AUTH_TOKEN`** in screenshots, public chats, etc. Rotate it if it leaks: change in `server.js` `.env`, change in router's `.env` (it's stored as `COOKIE_SYNC_AUTH_TOKEN`), change in n8n's HTTP Request nodes' Authorization headers, restart everything.
- **Be aware that `pm2 restart` causes ~5s of failed requests.** Plan restarts during low-traffic windows.

---

## 11. Tools and access summary

| What | Where |
|---|---|
| Source code | https://github.com/josipsare/manychat-clicker |
| Master VPS | Vultr → Frankfurt → 192.248.176.79, RDP |
| Router VPS | Vultr → Frankfurt → 45.63.119.187, SSH |
| Cloudflare | dash.cloudflare.com, Zero Trust → Networks → Tunnels |
| n8n | n8n.setty.ai |
| Slack alerts | The channel set up to receive FUs-logs webhook |
| Vultr console | my.vultr.com |

Ask Josip for credentials to each of these.

---

## 12. Where to go next

- **Daily reference**: `OPERATIONS.md` is the runbook. Bookmark it.
- **Code questions**: `server.js` is the main app, `router/router.js` is the load balancer. Both are well-commented.
- **Architecture questions**: this file (sections 3 and 4) and `OPERATIONS.md` (System overview section).
- **Historical context**: the git log shows the evolution. Specifically commit `c2fb107` is the "ready for deployment" state before Phase 1, and the Phase 1/2 commits add reliability and the router.

If something isn't clear, ask Josip directly — there's tribal knowledge that didn't make it into the docs. Add to this file when you learn something the next person should know.

Good luck.
