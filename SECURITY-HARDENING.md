# Security hardening plan

This branch is a code-review proposal only. It does not deploy, rotate credentials, rewrite Git history, touch Cloudflare, touch n8n, or mutate the production VPS.

## Caller inventory from repo docs/scripts

| Endpoint | Known/expected caller | Decision in this branch |
| --- | --- | --- |
| `GET /healthz` | Router/backend health checks, smoke checks | Stays public liveness-only. |
| `POST /press` | n8n follow-up workflows via `https://manychat-followupsv2.setty.ai/press`, through router to backend | Requires `Authorization: Bearer $AUTH_TOKEN` via shared `requireAuth`. Synchronous behavior is unchanged. |
| `GET /` | Human/operator diagnostic root showing config/endpoints | Requires bearer auth because it is not liveness-only. |
| `GET /dedup-status` | Human/operator diagnostics | Requires bearer auth; response is capped/summarized and does not expose raw dedup keys. |
| `POST /test-crash-notification`, `POST /test-dedup-notification` | Human/operator alert-smoke commands | Requires bearer auth. |
| `GET /init-login`, `GET /confirm-login`, `GET /switch-headless` | Human/operator session bootstrap/control | Requires bearer auth. |
| `GET /get-session` | Worker backends pulling cookies from the master via `COOKIE_SYNC_MASTER_URL`/`COOKIE_SYNC_AUTH_TOKEN` | Requires bearer auth. Existing cookie-sync auth header path remains. |
| `POST /transfer-session`, `POST /upload-user-data` | Legacy/manual deployment or master-rotation helpers | Requires bearer auth; still high risk and should be disabled or Cloudflare Access-gated in production once replacement flow exists. |
| `POST /sync-from-master`, `POST /sync-pool`, `POST /reinit-pool` | Worker/operator session-sync controls | Requires bearer auth. |
| `POST /debug-verify-login`, `GET /debug-session` | Human/operator diagnostics | Requires bearer auth; still sensitive because they expose browser/session state and should be Cloudflare Access-gated if public. |
| Router `GET /status` | Operator/load-balancer diagnostics on router | Not changed here; recommended Cloudflare Access or bearer auth follow-up for router non-liveness endpoints. |

## Sensitive artifacts and token-literal handling

Done in this branch:
- Removes tracked `user-data-backup.zip` and `session-data.json` from the repo index.
- Adds explicit `.gitignore` rules for those artifacts in addition to the broad `*.zip` rule.
- Replaces known hardcoded bearer-token literals in docs/scripts with placeholders.
- Adds a static regression test so those known literals do not reappear.

Still approval-gated and not done here:
- Rotate the real `AUTH_TOKEN`/`COOKIE_SYNC_AUTH_TOKEN` in backend, router, and n8n HTTP Request nodes.
- Rotate or invalidate any ManyChat/Chromium browser sessions that may have been captured in the committed ZIP/history.
- Rewrite Git history or purge GitHub cached artifacts/releases.
- Delete local production browser profile backups or change the running VPS session.

Suggested safe production sequence after review approval:
1. Confirm all current production callers and exact n8n credentials/headers for `/press`.
2. Deploy endpoint auth changes in a maintenance window or via a test hostname first.
3. Rotate API bearer tokens across backend/router/n8n atomically and run a benign `/press` smoke.
4. Re-login/rotate ManyChat browser session only after a tested backup/restore path exists.
5. Only then consider Git history purge / force-push with explicit approval and coordination.

## Cloudflare Access recommendation

Bearer auth should be the app-level baseline. For every public non-liveness hostname/path, add Cloudflare Access in front of admin/session/debug routes, at minimum:
- `/`, `/dedup-status`, `/debug-*`, `/init-login`, `/confirm-login`, `/switch-headless`
- `/get-session`, `/transfer-session`, `/upload-user-data`, `/sync-*`, `/reinit-pool`
- router `/status` and catch-all forwarding paths except `/press` and `/healthz`

Keep `/healthz` public and liveness-only. Keep `/press` reachable by n8n but bearer-authenticated; do not put it behind human-only Access unless n8n service-token headers are configured and tested.
