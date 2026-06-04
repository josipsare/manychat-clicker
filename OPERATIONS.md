# ManyChat Clicker — Operations Playbook

Reference document for running, scaling, and troubleshooting the ManyChat clicker system after Phase 2 cutover (router + master architecture).

Last updated: 2026-05-26
Author: rewritten with Claude during Phase 2 deployment

---

## Table of contents

- [System overview](#system-overview)
- [Current deployment state](#current-deployment-state)
- [URL reference](#url-reference)
- [Concurrency and capacity](#concurrency-and-capacity)
- [Day-to-day operations](#day-to-day-operations)
- [Monitoring and observability](#monitoring-and-observability)
- [Slack alerts reference](#slack-alerts-reference)
- [Phase 3 — Adding a worker backend](#phase-3--adding-a-worker-backend)
- [Removing a worker backend](#removing-a-worker-backend)
- [Rollback procedures](#rollback-procedures)
- [Troubleshooting](#troubleshooting)
- [Environment variable reference](#environment-variable-reference)
- [File and code locations](#file-and-code-locations)
- [Known limitations and future work](#known-limitations-and-future-work)

---

## System overview

```
                          ┌──────┐
                          │ n8n  │
                          └──┬───┘
                             │ POST https://manychat-followupsv2.setty.ai/press
                             ▼
                     ┌──────────────┐
                     │  Cloudflare  │ (DNS + Tunnel route → manychat-router)
                     └──────┬───────┘
                            ▼
                     ┌──────────────┐
                     │  Router VPS  │  (Ubuntu, 45.63.119.187)
                     │  /opt/router │  Node.js + PM2 + cloudflared
                     └──┬────────┬──┘
        Least-loaded    │        │
        with affinity   │        │
                        ▼        ▼
              ┌──────────┐   ┌────────────┐
              │ Backend  │   │ Backend    │   (more workers added by Phase 3+)
              │  master  │   │  worker-1  │
              └────┬─────┘   └────┬───────┘
                   │              │
                   ▼              ▼
           cloudflared      cloudflared
                   │              │
                   ▼              ▼
            localhost:3000  localhost:3000
            node server.js  node server.js
            (Windows)       (Linux or Windows)
                ManyChat        ManyChat
                session         session
            (master logs    (cookies pulled
             in directly)    from master)
```

### How a request flows

1. n8n POSTs to `https://manychat-followupsv2.setty.ai/press`
2. Cloudflare DNS resolves and routes via the `manychat-router` tunnel to the router VPS on `localhost:8080`
3. Router checks the **affinity cache**: has this exact request fingerprint been seen in the last 10 minutes?
   - **Yes** → forward to the same backend the original went to (preserves per-backend dedup)
   - **No** → pick the backend with the fewest in-flight requests right now (least-loaded)
4. Router forwards the request to the chosen backend's URL (via Cloudflare tunnel)
5. Backend's `server.js` runs the Playwright job: opens chat, types message, clicks send
6. Backend returns success/failure response
7. Router streams the response back to n8n

The proxy is **fully synchronous** — n8n's HTTP request stays open until the message is actually sent. This preserves the user's per-client rate-limiting model where the next request only fires after the previous one completes.

---

## Current deployment state

### Master VPS (Windows)

| Field | Value |
|---|---|
| Provider | Vultr |
| Location | Frankfurt (fra) |
| OS | Windows Server |
| Public IPv4 | `192.248.176.79` |
| Role | Original backend — also serves as cookie source for future workers |
| Code | `node server.js` running on `localhost:3000` |
| Concurrency | `SINGLE_CONTEXT_MAX_TABS=8` (8 parallel Playwright operations) |
| Cloudflare tunnel | `manychat-clicker` (ID `7338ad5c-4011-4bef-aab0-27498f04b118`) |
| Tunnel hostnames | `manychat-followupsv2.setty.ai` (legacy/inactive now), `manychat-backend.setty.ai` (active, used by router) |

### Router VPS (Ubuntu)

| Field | Value |
|---|---|
| Provider | Vultr |
| Location | Frankfurt (same region as master) |
| OS | Ubuntu 22.04 |
| Public IPv4 | `45.63.119.187` |
| Plan | `vhp-1c-1gb` ($6/mo, 1 vCPU, 1 GB, 25 GB NVMe) |
| Role | Load-balancing reverse proxy in front of all backends |
| Code | `/opt/router/router.js` running under PM2 on `localhost:8080` |
| Cloudflare tunnel | `manychat-router` (ID `572d060f-1c67-42e0-b90c-0143c8b98b31`) |
| Tunnel hostnames | `manychat-followupsv2.setty.ai` (production, post-cutover), `manychat-router-test.setty.ai` (test/smoke) |

### Cloudflare tunnels in use

| Tunnel name | Runs on | Routes |
|---|---|---|
| `manychat-clicker` | Master VPS | `manychat-backend.setty.ai` → `localhost:3000` |
| `manychat-router` | Router VPS | `manychat-followupsv2.setty.ai` → `localhost:8080`, `manychat-router-test.setty.ai` → `localhost:8080` |
| `manychat-followups` | (legacy, DOWN — can be deleted) | — |
| `manychat-followupsv2` | (legacy, INACTIVE — can be deleted) | — |

The two legacy tunnels (`manychat-followups`, `manychat-followupsv2`) are leftover from earlier deployments. They have no active routes and can be deleted from the Cloudflare dashboard whenever convenient — no impact on the running system.

---

## URL reference

| URL | Purpose | Status |
|---|---|---|
| `https://manychat-followupsv2.setty.ai/press` | **Production endpoint** that n8n calls | Active — routes to router |
| `https://manychat-backend.setty.ai` | Router uses this to reach the master backend | Active — internal |
| `https://manychat-router-test.setty.ai` | Smoke testing the router without touching production | Active — testing only |
| `https://manychat-worker-N.setty.ai` | Pattern for future worker backends | Reserve `manychat-worker-1.setty.ai`, etc. |

n8n only calls the production endpoint. The others are internal/operational.

---

## Concurrency and capacity

### Today (1 backend)

- Master VPS: `SINGLE_CONTEXT_MAX_TABS=8`
- Total effective concurrent jobs: **8**
- Single `/press` takes roughly 20-35 seconds (Playwright work)
- During concurrent operation, each backend has 8 parallel Playwright tabs in the same browser context

### Burst handling

For N simultaneous requests on M backends with concurrency C each, total wall time ≈ `ceil(N / (M × C)) × ~30s`.

| Burst size | 1 backend (today) | 2 backends | 3 backends |
|---|---|---|---|
| 8 | ~30 s | ~30 s | ~30 s |
| 16 | ~60 s | ~30 s | ~30 s |
| 32 | ~120 s | ~60 s | ~45 s |
| 64 | ~240 s | ~120 s | ~75 s |

The router has **no concurrency limit** — it'll forward as many requests as arrive. The bottleneck is always at the backends.

### Identifying when to add a backend

Watch the router's `/status` endpoint:

```
curl https://manychat-followupsv2.setty.ai/status
```

Look at `totalInFlight`. If you regularly see this number approach `(backends × 8)` and stay there, requests are queueing up at the backends. That's the signal to add a worker.

Other signs:
- n8n workflow timeouts increasing
- Slack `[DEDUP on ...]` alerts becoming frequent (suggests n8n retrying because original requests took too long)
- Master VPS CPU sustained above 70%

---

## Day-to-day operations

### Watching live router activity

```bash
# SSH to router VPS
pm2 logs router
# Ctrl+C to exit (router keeps running)
```

You'll see lines like:
- `LEAST-LOADED: routing to https://manychat-backend.setty.ai (in-flight before: 3)` — new request being routed
- `AFFINITY: routing to https://manychat-backend.setty.ai` — a retry being routed to same backend as original
- `Backend ... probe failed (1/2): timeout` — transient health probe failure (still considered healthy, no impact)
- `Backend ... health changed: true -> false` — real backend failure (after threshold)

### Checking router state

```bash
# Snapshot status
curl http://localhost:8080/status        # on the router VPS
# or from anywhere:
curl https://manychat-followupsv2.setty.ai/status
```

Response shows:
- Each backend's health, error count, in-flight requests
- Affinity cache size
- Total in-flight across all backends

### Checking PM2 status

```bash
pm2 status              # one-line summary of router process
pm2 monit               # live dashboard (Ctrl+C to exit)
pm2 logs router --err   # error logs only
```

### Restarting the router (zero-downtime is impossible; expect ~5s gap)

```bash
pm2 restart router
```

In-flight requests during the restart fail; n8n retries succeed (dedup-protected).

### Restarting the master `server.js`

Via RDP to master VPS:
- Stop `node server.js` (Ctrl+C in its terminal or task manager)
- Start it again with `node server.js`
- ~30s downtime; router marks backend unhealthy briefly, then back to healthy
- During this window, n8n requests return 503; retries succeed once master is back

### Updating router code

1. Edit `c:\Users\Korisnik\Desktop\JSAA\KLIJENTI\SETTAR\manychat-clicker\router\router.js` locally
2. Copy onto router VPS: `nano /opt/router/router.js`, paste, save
3. `pm2 restart router`

### Updating master code

1. Edit `c:\Users\Korisnik\Desktop\JSAA\KLIJENTI\SETTAR\manychat-clicker\server.js` locally
2. Copy onto master VPS via RDP (paste into the file there)
3. Stop and restart `node server.js`

### Checking ManyChat session validity

Via RDP to master, browse to `https://app.manychat.com` — if you're logged in, session is good. If kicked to login, re-login and the session persists into the user-data folder.

For workers (Phase 3+): no need to log in; they pull cookies from the master via `/get-session`.

---

## Monitoring and observability

### Endpoints

| Endpoint | What it tells you |
|---|---|
| `GET /healthz` on router | Are any backends healthy? Yes/no. |
| `GET /status` on router | Per-backend health, in-flight counts, affinity cache size |
| `GET /healthz` on backend | Backend is up and `server.js` responds |
| `GET /dedup-status` on backend | What's currently in the dedup map (cached or in-flight) |

### Slack alerts

All alerts go to the existing `FOLLOWUP_LOG_WEBHOOK_URL` (`https://n8n.setty.ai/webhook/FUs-logs`). The n8n workflow there routes based on the `event` field.

| Event type | When it fires | Action needed |
|---|---|---|
| `event: 'crash'` | Backend caught an `uncaughtException` or `unhandledRejection` (process stayed alive) | Investigate the error; usually transient but worth knowing |
| `event: 'dedup-blocked'` | Backend blocked a duplicate retry from n8n (cached or in-flight) | Informational — confirms dedup is working |
| (no `event` field) | Regular follow-up log: every `/press` outcome | Normal log entry |

Rate limits:
- Crash alerts: max 1 per minute (other crashes during cooldown are counted into `suppressedSinceLast` in the next alert)
- Dedup alerts: max 1 per 5 minutes (similar rolling counter)

### What "healthy" actually means

The router considers a backend healthy if it responded `200 OK` to `/healthz` within the last 10 seconds AND it's had fewer than 2 consecutive failed probes. Probes run every 15s.

A single probe failure logs as `Backend X probe failed (1/2): <reason>` but does NOT mark the backend unhealthy. Only after 2 consecutive failures does it flip.

---

## Phase 3 — Adding a worker backend

When `totalInFlight` regularly approaches backend capacity, or you preemptively want more headroom, add a worker.

### Prerequisites checklist

- [ ] You have ~30-45 minutes uninterrupted
- [ ] You can SSH or RDP to the new VPS once provisioned
- [ ] Master VPS is healthy and reachable (workers will pull cookies from it on startup)

### Step 1 — Provision the new VPS

Vultr:
- Type: Shared CPU (same as master), or whatever matches your needs
- Location: same region as the existing VPSs (Frankfurt)
- OS: Ubuntu 22.04 (easier than Windows; Linux Playwright is faster)
- Size: matches the master's workload — typically 2 vCPU, 4 GB RAM for Playwright is good
- Hostname: `manychat-worker-1` (or `-2`, `-3`, etc. for subsequent workers)

Note both the **public IPv4** and (if VPC enabled) the **private IPv4**.

### Step 2 — Install dependencies on the worker VPS

SSH in as root:

```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Playwright dependencies on Linux:
npx playwright install-deps chromium
```

(If `npx` complains, install Playwright globally first or copy the project then npm install.)

### Step 3 — Copy server.js and package.json

Create the project directory:

```bash
mkdir -p /opt/manychat-clicker
cd /opt/manychat-clicker
```

Paste `server.js` and `package.json` from the local repo at `c:\Users\Korisnik\Desktop\JSAA\KLIJENTI\SETTAR\manychat-clicker\`.

Install deps:
```bash
npm install
npx playwright install chromium
```

### Step 4 — Configure the worker's `.env`

```bash
cat > /opt/manychat-clicker/.env <<'EOF'
AUTH_TOKEN=<same as master's AUTH_TOKEN>
PORT=3000
HEADLESS=true
USE_SINGLE_CONTEXT=true
SINGLE_CONTEXT_MAX_TABS=8
USER_DATA_DIR=/opt/manychat-clicker/data/user-data

# Worker mode — pulls cookies from master via this URL on startup and every 30 min:
COOKIE_SYNC_MASTER_URL=https://manychat-backend.setty.ai
COOKIE_SYNC_AUTH_TOKEN=<same as master's AUTH_TOKEN>

# Friendly name in Slack alerts:
SERVER_NAME=worker-1

# Same FOLLOWUP_LOG_WEBHOOK_URL as master for crash/dedup alerts:
FOLLOWUP_LOG_WEBHOOK_URL=https://n8n.setty.ai/webhook/FUs-logs
EOF
chmod 600 /opt/manychat-clicker/.env
```

### Step 5 — Start the worker

Using PM2 (install if not present: `npm install -g pm2`):

```bash
cd /opt/manychat-clicker
pm2 start server.js --name manychat-worker
pm2 save
pm2 startup    # follow the printed command if any
pm2 logs manychat-worker --lines 30
```

You should see in the logs:
```
[cookie-sync] Worker mode: master=https://manychat-backend.setty.ai, interval=1800000ms
[cookie-sync] Fetching session from master: ...
[cookie-sync] Applied N cookies from master
manychat-clicker listening on :3000 (headless=true, concurrency=8, singleContext=true maxTabs=8)
✅ Login session found - ready to send messages!
```

Verify locally:
```bash
curl http://localhost:3000/healthz
# Should return: {"ok":true,...}
```

### Step 6 — Set up a Cloudflare tunnel for the worker

In Cloudflare Zero Trust dashboard → Networks → Tunnels → **Create a tunnel**:

1. Type: Cloudflared
2. Name: `manychat-worker-1`
3. Save. Copy the install command (Debian / 64-bit).

On the worker VPS, paste and run the install command. PM2-style service starts automatically.

Verify in Cloudflare dashboard: tunnel `manychat-worker-1` shows **Healthy**, connector listed with origin IP = worker VPS IP, platform = `linux_amd64`.

### Step 7 — Add a public hostname route to the worker tunnel

In Cloudflare: tunnel `manychat-worker-1` → **Published application routes** tab → **+ Add a published application route**:

- Subdomain: `manychat-worker-1`
- Domain: `setty.ai`
- Path: empty
- Service type: HTTP
- URL: `localhost:3000`
- Save

Wait ~30 seconds. Verify from anywhere:

```bash
curl -i https://manychat-worker-1.setty.ai/healthz
# Expect 200 OK with the server's JSON
```

### Step 8 — Add the worker to the router's `BACKENDS`

SSH to the router VPS:

```bash
cd /opt/router
nano .env
```

Change `BACKENDS=` to include the worker, comma-separated:

```
BACKENDS=https://manychat-backend.setty.ai,https://manychat-worker-1.setty.ai
```

Save. Restart router:

```bash
pm2 restart router
pm2 logs router --lines 15
```

Expected startup banner:
```
Backends (2): https://manychat-backend.setty.ai, https://manychat-worker-1.setty.ai
```

Wait ~30 seconds for the router to do its first health probe of the new backend. Then verify:

```bash
curl https://manychat-followupsv2.setty.ai/status
```

You should see **two** backends both with `healthy: true`.

### Step 9 — Verify the new worker receives traffic

Watch router logs:
```bash
pm2 logs router
```

Within minutes (depending on n8n traffic volume), you should see routing decisions alternating between the two backends:
```
LEAST-LOADED: routing to https://manychat-worker-1.setty.ai (in-flight before: 0)
LEAST-LOADED: routing to https://manychat-backend.setty.ai (in-flight before: 0)
```

To force a test through the new worker, send a benign `/press` and watch which backend it goes to.

### Step 10 — Confirm both backends are doing real work

Via SSH to worker: `pm2 logs manychat-worker` should show incoming `/press` requests.

Via RDP to master: master's terminal should keep showing requests too.

If both backends are processing traffic, **Phase 3 is complete** for this worker.

---

## Removing a worker backend

If you ever need to take a worker offline (maintenance, decommission, etc.):

### Soft removal (drain then remove)

1. On the router VPS, edit `.env` to remove the worker from `BACKENDS=`.
2. `pm2 restart router`.
3. Router immediately stops sending new requests to that worker.
4. In-flight requests on that worker complete normally (router waits for them).
5. After ~10 minutes (the affinity cache TTL), no more retries route there either.
6. Shut down the worker safely.

### Hard removal (immediate)

If the worker is broken/unresponsive:

1. Just shut down the worker VPS (`shutdown -h now` or stop in Vultr).
2. Router's next health probe (within 15s) marks it as unhealthy.
3. After 2 consecutive failures (~30s), router stops routing new traffic there.
4. Affinity cache entries for that backend get cleared as they're encountered (because the backend is unhealthy).
5. Eventually edit the router's `.env` to remove the dead backend from `BACKENDS=` so the router stops probing it.

---

## Rollback procedures

### Rollback the entire Phase 2 (revert to direct n8n → master)

If something goes catastrophically wrong with the router:

1. In Cloudflare → Zero Trust → Networks → Tunnels → `manychat-router` → Published application routes:
   - Delete `manychat-followupsv2.setty.ai`
2. In Cloudflare → Zero Trust → Networks → Tunnels → `manychat-clicker` → Published application routes:
   - Add: subdomain `manychat-followupsv2`, domain `setty.ai`, HTTP, URL `localhost:3000`

Within ~10 seconds, n8n traffic goes directly to the master through the old tunnel path, bypassing the router entirely. The router keeps running but receives no traffic.

### Rollback a Phase 3 worker (revert to single-backend operation)

1. On the router VPS, edit `.env` to remove the worker URL from `BACKENDS=`.
2. `pm2 restart router`.
3. All traffic returns to the master backend.

### Rollback a code change to router.js

1. Get the old version from local git history or from a backup.
2. Paste onto VPS, `pm2 restart router`.

If you didn't keep a backup, you can quickly revert to a "minimal pass-through" router by reverting `router.js` to just forwarding to the first backend in `BACKENDS=`. But best practice: keep a backup of the working `router.js` (e.g., `cp /opt/router/router.js /opt/router/router.js.bak`) before any change.

---

## Troubleshooting

### `/healthz` on router returns 503

Means no backend is healthy. Check:
- `curl http://localhost:8080/status` to see which backend is failing and why
- The backend's URL — can you `curl` it directly from the router VPS?
- The backend's Cloudflare tunnel — is it still Healthy in the dashboard?
- The backend's `server.js` — is the process running on the backend VPS?

Common fixes:
- Restart the backend's `server.js`
- Restart `cloudflared` on the backend: `systemctl restart cloudflared` (Linux) or restart the service (Windows)

### n8n requests are slow or timing out

- Check router's `/status` — what's `totalInFlight`? If it equals backends × concurrency, you're saturated.
- Solution: add a worker (Phase 3).
- Check master's CPU/memory via RDP — if sustained 90%+, the VPS is undersized.

### Lots of `[DEDUP on ...]` Slack alerts

This means n8n is retrying frequently. Causes:
- n8n's HTTP timeout is shorter than the actual request time → n8n thinks the request failed, retries → dedup correctly blocks the duplicate.
- Fix: increase n8n's HTTP request timeout in your workflow.
- Or: add more backends to reduce queue wait.

### `[CRASH on ...]` Slack alerts

Investigate the message and stack trace in Slack. Common causes:
- Playwright navigation timeout when ManyChat is slow → usually recovers automatically
- ManyChat UI changed and a selector doesn't match → may need a `server.js` patch

Check the backend's logs (`pm2 logs manychat-worker` on Linux, or the Windows terminal log) for context.

### Worker can't pull cookies from master

If a worker fails to start with "Master returned 401":
- Verify `COOKIE_SYNC_AUTH_TOKEN` in worker's `.env` matches `AUTH_TOKEN` on master.

If "Master returned 404" or "Connection refused":
- Verify the worker can reach `https://manychat-backend.setty.ai/healthz` (the backend URL).
- Check that `manychat-clicker` tunnel on master is still Healthy.

### Sessions expiring on workers

Workers pull cookies from master every 30 minutes by default. If master's ManyChat session expires:
- Master starts returning login pages
- Worker pulls stale cookies, also fails
- Fix: RDP into master, log into ManyChat manually, session refreshes, workers pick up fresh cookies on next sync.

To force an immediate sync on a worker: `curl -X POST http://localhost:3000/sync-from-master` (with appropriate auth).

### Router restarts unexpectedly

Check `pm2 logs router --err` for crashes. The router has crash guards but if something panics in C-level code (rare), PM2 will restart it. PM2 keeps it alive.

If the router is in a restart loop:
- Check the `.env` for syntax errors (`cat .env`)
- Check `router.js` syntax: `node --check /opt/router/router.js`
- Check `node_modules/` is intact: `ls /opt/router/node_modules`

---

## Environment variable reference

### Master (`server.js`)

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_TOKEN` | (required) | Bearer token for `/press` and admin endpoints |
| `PORT` | `3000` | HTTP port |
| `HEADLESS` | `true` | Run Playwright headless |
| `USE_SINGLE_CONTEXT` | `true` | Use one browser context with tabs |
| `SINGLE_CONTEXT_MAX_TABS` | `4` | Concurrency (master is set to `8`) |
| `USER_DATA_DIR` | `./data/user-data` | Playwright persistent profile (session lives here) |
| `JOB_TIMEOUT_MS` | `420000` | Max time per `/press` (7 min) |
| `DEDUP_WINDOW_MS` | `600000` | How long dedup remembers a sent message (10 min) |
| `STAGGER_DELAY_MS` | `2500` | Max random delay before each job starts (0-2.5s) |
| `FOLLOWUP_LOG_WEBHOOK_URL` | `https://n8n.setty.ai/webhook/FUs-logs` | Slack alerts and follow-up logs |
| `SERVER_NAME` | `manychat-clicker` | Friendly name in Slack alerts |
| `COOKIE_SYNC_MASTER_URL` | (empty) | If set, this VPS acts as a worker pulling cookies from this URL |
| `COOKIE_SYNC_AUTH_TOKEN` | `AUTH_TOKEN` | Token used to authenticate to master's `/get-session` |
| `COOKIE_SYNC_INTERVAL_MS` | `1800000` | How often workers re-pull cookies (30 min) |

### Router (`router.js`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port the router listens on |
| `BACKENDS` | (required) | Comma-separated list of backend URLs |
| `HEALTH_CHECK_INTERVAL_MS` | `15000` | How often to probe each backend's `/healthz` |
| `HEALTH_CHECK_TIMEOUT_MS` | `10000` | Per-probe timeout |
| `HEALTH_CHECK_FAILURE_THRESHOLD` | `2` | Consecutive failures before marking unhealthy |
| `PROXY_TIMEOUT_MS` | `600000` | Max time the router waits for backend response (10 min) |
| `AFFINITY_TTL_MS` | `600000` | How long the router remembers which backend a request fingerprint went to (10 min) |

---

## File and code locations

### Local development (Windows)

```
c:\Users\Korisnik\Desktop\JSAA\KLIJENTI\SETTAR\manychat-clicker\
├── server.js                  # Master backend code
├── package.json
├── .env                       # Local dev config (NOT pushed to VPSs)
├── .env.example               # Template
├── router/
│   ├── router.js              # Router code
│   ├── package.json
│   ├── .env                   # Local example
│   └── .env.example
└── OPERATIONS.md              # This file
```

### Master VPS (Windows)

Whatever folder the user has it in. Run `node server.js` from there.
- The `.env` is alongside `server.js`
- `data/user-data/` contains the Playwright persistent profile (Chromium cookies, localStorage, etc.)
- DO NOT delete this folder without re-logging into ManyChat afterward

### Router VPS (Ubuntu)

```
/opt/router/
├── router.js                  # Pasted from local repo
├── package.json
├── .env                       # Configured for this deployment
├── node_modules/              # Created by npm install
└── (no persistent data — affinity cache is in-memory)
```

PM2 process name: `router`
- Logs: `/root/.pm2/logs/router-out.log` and `router-error.log`
- View live: `pm2 logs router`

### Future workers (Ubuntu)

```
/opt/manychat-clicker/
├── server.js                  # Same as master's server.js
├── package.json
├── .env                       # Configured with COOKIE_SYNC_MASTER_URL pointing at master
├── node_modules/
└── data/user-data/            # Playwright profile (populated via cookie sync)
```

PM2 process name: `manychat-worker` (or `manychat-worker-1`, etc.)

---

## Known limitations and future work

### Single point of failure: the router VPS

If the router VPS goes down, the entire system is down (n8n can't reach any backend). Mitigations:
- PM2 auto-restart for crashed processes
- Crash guards in router.js prevent most fatal errors
- Router is a small, simple app (low chance of crashing)

If we ever need HA: run two routers behind a Vultr load balancer, or use Cloudflare's load balancing in front of two router tunnels. Not needed at current scale.

### Cookie sync requires master to be up

Workers pull cookies from master on startup and every 30 min. If master is permanently dead:
- Existing workers continue running on the cookies they already have (until session expires)
- New workers can't start

Mitigation: if master dies, log into ManyChat on one of the workers and reconfigure that worker as the new master (remove `COOKIE_SYNC_MASTER_URL` from its .env, point other workers' `COOKIE_SYNC_MASTER_URL` at it).

### Affinity cache is router-local, not shared

If we ever scale to multiple routers, the affinity cache would need to be shared (Redis) so retries always land on the same backend. Not needed at current scale (1 router).

### No automatic scaling

We don't auto-add backends based on load. Capacity decisions are manual:
- Watch `/status` and Slack
- Run a Phase 3 deployment when needed

This is fine for current scale. Auto-scaling would require infrastructure changes (e.g., Terraform + Vultr API).

### No request-level metrics / SLO dashboard

We see logs but don't aggregate them. If we want metrics like "p95 latency over the last hour", we'd need to ship logs to a service (Loki, Datadog, etc.).

For now: Slack alerts cover the important events. Logs are accessible via `pm2 logs`.

---

## Quick reference card

```
# Router VPS (Ubuntu, 45.63.119.187)
ssh root@45.63.119.187
cd /opt/router
pm2 status                            # is router running?
pm2 logs router                       # live logs
curl http://localhost:8080/healthz    # quick health
curl http://localhost:8080/status     # detailed status

# Master VPS (Windows, 192.248.176.79)
# Via RDP
# Open the project folder
# Look at the console running `node server.js`

# Production endpoint
curl -i https://manychat-followupsv2.setty.ai/healthz
curl -i https://manychat-followupsv2.setty.ai/status

# Cloudflare dashboard
# https://dash.cloudflare.com → Zero Trust → Networks → Tunnels
```

---

## Glossary

| Term | Meaning |
|---|---|
| **Master** | The original backend VPS (Windows, master ManyChat login lives here) |
| **Router** | The reverse proxy that distributes requests to backends |
| **Backend** | A `server.js` instance (master or worker) that does the actual Playwright work |
| **Worker** | A non-master backend; pulls cookies from master via `COOKIE_SYNC_MASTER_URL` |
| **Affinity cache** | Router-side memory of which backend each unique request fingerprint went to. Preserves per-backend dedup across retries. |
| **Dedup** | Backend-side mechanism that blocks duplicate `/press` requests (n8n retries, etc.) |
| **Affinity-preserved dedup** | Combination: router's affinity routes the same request fingerprint to the same backend, where backend's dedup catches the duplicate. |
| **Least-loaded routing** | Router picks the backend with the fewest in-flight requests for each new request. |
| **Spillover / Failover** | Removed in current design — no longer needed once routing is by load. Failover happens implicitly when an unhealthy backend is filtered out of the candidate list. |
| **Phase 1** | Crash guards + dedup + Slack alerts (deployed on master). Complete. |
| **Phase 2** | Router + cookie sync infrastructure. Complete as of cutover on 2026-05-26. |
| **Phase 3** | Add a worker backend. Pending (whenever capacity demands). |
