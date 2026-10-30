# NightShift

NightShift is a 24-hour hackathon demo of an AI on-call engineer. It watches a small
Node/Express checkout system, finds the service that actually caused a failure, proves a
fix in a shadow copy before touching production, applies it only when the evidence is
good, and writes a plain-English receipt.

The demo system is three services:

```
browser / traffic
      |
    orders (4001)
    /          \
payments (4002)  inventory (4003)
```

`orders` calls `payments` and `inventory`, so when a downstream service breaks, `orders`
looks broken too. NightShift must tell the cause from the symptom.

## What it does

- Collects `/health` and `/metrics` from every service every 2 seconds.
- Raises an anomaly only after two consecutive bad samples, so one noisy sample is not an incident.
- Builds a root-cause graph from the dependency map. A failing downstream service is the cause;
  its failing callers are symptoms.
- Freezes the diagnosis once remediation starts, so a recovering system cannot rewrite history.
- Tries fixes in order of risk. Every fix runs in a fresh shadow clone on ports 4100-4199,
  against real requests captured from production and replayed into the clone. If the capture
  window is empty, a built-in recorded fixture keeps verification available.
- Promotes a fix only when the replay has enough samples and all verdict rules pass:
  - error rate at or below 1% when the baseline was zero;
  - error rate reduced by at least half otherwise;
  - p95 latency no worse than the larger of the baseline or a 500 ms noise floor.
- Applies low-risk fixes automatically, up to **3 actions per rolling 10 minutes**. Extra
  actions wait as `rate_limited` instead of piling onto a damaged system.
- Stops before medium and high-risk fixes and asks for approval in the dashboard.
- Watches production after a fix. If errors regress, it restores the pre-fix state and escalates.
- Writes a **Heal Receipt** for every closed incident. A deterministic template is saved first;
  an optional free-tier LLM may reword it, but can never choose or apply a fix. Its output is
  rejected if it adds a number or service name that is not in the facts.
- Rejects the demo decoy: a stale configuration snapshot can be shadow-verified, but it is
  never allowed to reach production.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- No MongoDB install: the healer starts an embedded MongoDB by default

## Run it

```bash
npm install
npm start
```

Open <http://localhost:5173>. The first run downloads the embedded MongoDB binary, which can
take a minute.

`npm start` runs three processes:

| Process | Port | Purpose |
| --- | --- | --- |
| healer | 4000 | API, Socket.IO, detector, shadow verifier, remediator; also starts the three demo services |
| traffic | - | Synthetic checkout traffic (2 requests/second by default) |
| dashboard | 5173 | React UI with an API and WebSocket proxy to the healer |

To run without the dashboard, use `npm run healer` and `npm run traffic` in separate terminals.

Optional: copy `.env.example` to `.env` and uncomment what you need. Everything has a working
default. The healer and traffic generator read the root `.env` automatically.

## Demo script (about 3 minutes)

1. **Tour (15 s).** Three healthy services, `Automatic actions 0/3`, and the audit trail.
2. **Bad config on payments (45 s).** Press **Bad config** on the payments card.
   - `orders` starts failing and appears in the incident as a symptom; `payments` is the root cause.
   - The shadow panel shows the replay: revert config is tested in a clone, not in production.
   - The low-risk fix is applied, the 60-second watch passes, and the incident resolves.
   - Show the Heal Receipt. It names the cause, the symptom, the fix, before/after numbers, and the outcome.
3. **Crash on payments (45 s).** Press **Crash**. The service becomes unreachable. Restart is
   verified by replaying real captured requests into a fresh clone, then applied. The receipt
   says that payments stopped responding.
4. **Slow on payments (45 s).** Press **Slow**. The shadow replay shows whether a restart really
   restores latency. The fix is applied and watched. The cap reaches 3/3, showing that a fourth
   automatic action would wait.
5. **Decoy and escalation (30 s, optional).** In a terminal:

   ```bash
   npm run scenario -- decoy
   ```

   A stale configuration snapshot is offered as a fix but rejected by verification, and it is
   never allowed in production. The incident escalates to a human instead of guessing.

After the demo, restore a clean stage:

```bash
npm run reset
```

`reset` clears incidents, receipts, attempts, captured requests, snapshots, and the audit log,
resets the action cap and service configuration, and restarts all services healthy. It refuses
to run while a remediation is in progress.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm start` | Healer + services + traffic + dashboard in one terminal |
| `npm run healer` | Healer and demo services only |
| `npm run dashboard` | Dashboard only, expects a healer on port 4000 |
| `npm run traffic` | Synthetic checkout traffic |
| `npm run reset` | Clear demo state and restart services healthy |
| `npm run scenario -- crash` | Verify one end-to-end scenario: `crash`, `slow`, `memory_leak`, `bad_config`, `decoy`, `approval`, `gray`, `gray_slow`, `flap` |
| `npm test` | 102 Vitest unit tests |
| `npm run typecheck` | TypeScript check across all workspaces |

The scenario runner expects a live healer with traffic running. It waits for quiet, injects the
fault, follows the incident to a terminal state, checks the outcome and the receipt, and exits
non-zero on failure. Each run prints its time to heal, measured from the first bad sample. The `flap` scenario
re-injects a gray fault after every fix and expects the circuit breaker to stop a restart storm. The `approval` scenario restricts the allowed fix to a medium-risk reset,
waits at the approval gate, approves it through the API, and expects the heal to complete. It is
the rehearsal check, not part of the UI.

## Configuration

All variables are optional. See `.env.example`.

| Variable | Default | Notes |
| --- | --- | --- |
| `HEALER_PORT` | `4000` | Healer HTTP and Socket.IO port |
| `HEALER_URL` | `http://localhost:4000` | Used by services, dashboard proxy, and scripts |
| `DASHBOARD_PORT` | `5173` | Vite dev server port |
| `MONGODB_URI` | unset | When unset, an embedded MongoDB is started |
| `TRAFFIC_RPS` | `2` | Synthetic checkouts per second |
| `ACTION_CAP_MAX` | `3` | Automatic applied actions per window |
| `ACTION_CAP_WINDOW_MINUTES` | `10` | Rolling cap window |
| `APPROVAL_TIMEOUT_MINUTES` | `15` | How long a risky fix waits for a human |
| `WATCH_SECONDS` | `60` | Post-fix production watch |
| `LLM_ENABLED` | `true` if a key exists | Set to `false` to force template receipts |
| `GROQ_API_KEY` / `GROQ_MODEL` | unset / `openai/gpt-oss-20b` | First optional receipt provider |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | unset / `gemini-flash-latest` | Second optional provider |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | unset / a `:free` model | Last optional provider |

LLM failures, timeouts, rate limits, or rejected replies fall back to the template receipt.
No key is required for the core demo.

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Healer liveness |
| `GET /api/state` | Services, latest snapshots, active incident, pending approvals, cap |
| `GET /api/incidents` / `GET /api/incidents/:id` | Incident list and detail with attempts |
| `GET /api/receipts/:incidentId` | Heal Receipt, 404 until the incident closes |
| `GET /api/audit` | Audit trail |
| `GET /api/scorecard` | Time to heal and what a blind auto-restart policy would have done, counted from the record |
| `GET /api/captures?service=payments` | Masked captured requests used for replay |
| `POST /api/approvals/:attemptId` | `{ "decision": "approve" \| "reject" }` |
| `POST /api/chaos` | `{ "service": "payments", "fault": "crash" }`; `null` clears the fault |
| `POST /api/services` | Update a service's dependencies or allowed fix types |
| `POST /api/reset` | Used by `npm run reset` |

Captured requests are masked before storage: card numbers, emails, authorization headers, and
other denylisted fields are replaced with type-preserving placeholders. The dashboard and the
LLM never see raw secrets. The LLM receives only the receipt facts, never the captured traffic.

## Layout

```
shared/      types, dependency graph constants, masking
services/    demo service, fault injection, traffic generator
healer/      collector, detector, diagnosis, catalog, shadow verifier, remediator,
             approvals, action cap, supervisor, receipts, API, Socket.IO
dashboard/   React/Vite/Tailwind UI
scripts/     scenario runner and reset client
```

## Troubleshooting

- **Dashboard shows "Polling every 5 s".** The Socket.IO connection is down, so the UI is
  falling back to a 5-second refresh. The demo still works; check the healer terminal.
- **Port already in use.** Stop the old process or run `npm run reset`. On Windows,
  `Get-NetTCPConnection -LocalPort 4000` identifies the listener.
- **First start seems stuck.** The embedded MongoDB binary is downloading. Wait, or point
  `MONGODB_URI` at an existing MongoDB.
- **Receipt says "worded by template".** No LLM key was configured, or every provider failed
  or was rejected. This is the intended safe fallback, not a demo failure.
- **Incident waits at `awaiting approval`.** A medium or high-risk fix passed the shadow test.
  Approve or reject it in the dashboard. After 15 minutes it times out and escalates.
- **Automatic actions are rate limited.** Three actions were applied in 10 minutes. Wait for
  the window, or run `npm run reset` between rehearsals.
- **Ports stay open after Ctrl+C.** Stop the remaining Node processes; the supervisor also
  shuts down its children on the healer's SIGINT/SIGTERM.
