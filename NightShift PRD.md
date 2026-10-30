# NightShift PRD

Oct 30, 2026 · @Codestorm

## Problem Statement

When a service breaks at 3 AM, a human still has to wake up, work out the cause and fix it, and the tools that automate the fix often act blindly and make things worse.

Small dev teams, startups and campus IT groups run Node and React services with nobody on call around the clock. Their pain is concrete:

- Failures at night go unnoticed until users complain, so downtime lasts hours.
- Alerts show symptoms (a slow checkout) rather than the root cause (a failing payments service), so engineers lose time chasing the wrong service.
- Automatic restarts and rollbacks run without proof they help. A bad auto-fix can turn a small incident into a full outage.
- After an incident, nobody can say in plain words what broke, why, and what was changed.

The wider context: ITIC's 2024 survey reports over 90% of mid-size and large enterprises lose more than $300,000 per hour of downtime, and a Catchpoint 2025 report says about 70% of SREs link on-call stress to burnout and attrition. Only a minority of mid-market firms (18% in one 2026 vendor survey) have any AIOps tooling, so smaller teams are the least served.

## Solution

NightShift is an on-call engineer that never sleeps: it detects a failing service, finds the real culprit, proves a fix works on a shadow copy using replayed real traffic, applies it only if it beats the baseline, and then explains what it did in plain English.

From the operator's point of view, the flow has five steps:

1. **Detect.** NightShift watches health, error rate, latency and memory for every registered service and shows them live on a dashboard.
2. **Diagnose.** A dependency graph separates the root-cause service from the services that only look broken because they depend on it.
3. **Verify.** NightShift starts a shadow clone of the faulty service with the candidate fix and replays recently captured traffic against it, comparing error rate and latency with the current baseline.
4. **Heal.** If the shadow beats the baseline, the fix is promoted to production. If not, NightShift discards it, tries the next candidate or escalates to a human. Risky actions always wait for approval.
5. **Explain.** Each incident ends with a Heal Receipt: what broke, why, which fix was tried, the before and after numbers, and the final outcome.

A built-in Chaos Button lets the operator break a demo service on stage (crash, slow response, memory leak, bad config) so the whole loop can be shown live.

### Options considered

| Option | Verdict | Reason |
| --- | --- | --- |
| Alert and page a human (status quo) | Rejected | Does not solve the 3 AM problem |
| Auto-restart on failure | Included as one fix candidate | Cheap, but fixes only one failure type and can loop |
| Auto-remediate blindly with playbooks | Rejected | A wrong fix can worsen an outage |
| Shadow-verified healing with human approval for risky fixes | Chosen | Safe, explainable, and demoable in 24 hours |

## User Stories

1. As an on-call developer, I want to see every service's health, error rate and latency live, so that I know the system's state at a glance.
2. As an on-call developer, I want to be told which service is the root cause, so that I do not chase symptoms.
3. As an on-call developer, I want a failing service to be fixed automatically at night, so that I can sleep through routine incidents.
4. As an on-call developer, I want every fix proven on shadow traffic before it touches production, so that an auto-fix cannot make an outage worse.
5. As an on-call developer, I want a fix that does not improve things to be rolled back automatically, so that production is never left worse than before.
6. As an on-call developer, I want risky actions to wait for my approval, so that I stay in control of high-impact changes.
7. As an on-call developer, I want to approve or reject a pending fix from the dashboard in one click, so that I can respond quickly from my phone.
8. As an engineering lead, I want a plain-English Heal Receipt for every incident, so that I can review what broke, why and what changed without reading logs.
9. As an engineering lead, I want a timeline of incidents with before and after metrics, so that I can see how much downtime was avoided.
10. As an engineering lead, I want a limit on how many automatic actions run in a time window, so that a faulty healer cannot cause a cascade of changes.
11. As a service owner, I want to register a service with its health endpoint and its dependencies, so that NightShift knows what to watch and how services relate.
12. As a service owner, I want to choose which fix types are allowed per service, so that sensitive services only use safe actions.
13. As a service owner, I want NightShift to try fixes from safest to riskiest, so that the least disruptive fix is tried first.
14. As a judge or demo audience member, I want a Chaos Button that breaks a service on demand, so that I can watch detection, diagnosis, verification and healing happen live.
15. As a judge or demo audience member, I want to see the shadow test results side by side with the baseline, so that I can trust why the fix was promoted or rejected.
16. As a new team member, I want to start the whole demo environment with a single command, so that setup takes minutes, not hours.
17. As a security-conscious operator, I want an audit trail of every automatic action with who or what triggered it, so that changes are accountable.
18. As an operator, I want captured traffic to avoid storing sensitive fields, so that replaying it does not leak private data.

## Implementation Decisions

The system is split into a few deep modules: each hides a lot of logic behind a small interface that rarely changes, so each can be tested alone.

### Modules

| Module | What it hides | Simple interface |
| --- | --- | --- |
| Signal Collector | Health pings, metric sampling, traffic capture into a rolling buffer | Emits a stream of service snapshots |
| Incident Detector | Thresholds and trend rules for error rate, latency and memory | Snapshot in, anomaly (or nothing) out |
| Root-Cause Graph | Service dependency graph and blame ranking | Set of anomalies in, ranked culprit list out |
| Fix Catalog | Candidate fixes per failure type, each tagged with a risk level | Failure type in, ordered candidate fixes out |
| Shadow Verifier | Starting a clone, applying a fix, replaying captured traffic, comparing against baseline | Service, fix and traffic window in, verdict with before and after numbers out |
| Remediator | Promoting a verified fix, rollback, rate limit on actions, approval gate | Verified fix in, applied, rolled back or awaiting approval out |
| Receipt Writer | Turning an incident record into a plain-English explanation | Incident in, receipt out |
| Incident Store | Saving and querying incidents, receipts and the audit log | Save and query operations |
| Live Gateway | Pushing snapshots, incidents and receipts to the dashboard in real time | Publish and subscribe on named channels |
| Chaos Injector | Breaking a demo service on demand | Service and failure type in, fault started out |

### Key decisions

- **Architecture.** A Node and Express healer service supervises a small set of Node and Express demo services (orders, payments, inventory). A React and Tailwind dashboard connects through Socket.IO. MongoDB stores incidents, receipts, the audit log and registered services.
- **Data source.** All data is synthetic: a traffic generator drives the demo services and the Chaos Injector creates failures. No real user data is used.
- **Shadow verification.** A shadow clone gets the candidate fix and a replay of a recent window of captured requests. A fix is promoted only if error rate and latency both beat the baseline by a set margin.
- **Safety rules.** Fixes are ordered from least to most risky. Low-risk fixes run automatically, risky fixes need human approval, and a cap limits the number of automatic actions per time window.
- **Root cause.** A rule-based dependency graph decides the culprit, which keeps it fast, explainable and reliable in a demo. An optional language model may only word the plain-English receipt; it never chooses or applies a fix.
- **Privacy.** Captured traffic masks sensitive fields before it is stored or replayed.
- **Data model (in words).** A service has a name, health endpoint, dependencies and allowed fix types. An incident has a service, symptom, ranked causes, attempted fixes with verdicts, outcome and timestamps. A receipt belongs to one incident and holds the explanation and before and after metrics.
- **Deployment.** Everything runs locally with a single start command; the demo services run as supervised processes, so no container tooling is required.

## Testing Decisions

A good test checks external behavior through a module's simple interface, never its internal steps, so tests survive refactors made during a 24-hour build.

- **Tested with automated tests:** Incident Detector, Root-Cause Graph, Shadow Verifier (verdict logic), Remediator (approval gate, rollback, action cap) and Fix Catalog. These are pure decision logic and carry the product's safety promise.
- **Tested by scenario run, not unit tests:** the full loop, by running each Chaos Injector failure (crash, slow response, memory leak, bad config) and confirming the expected receipt appears.
- **Checked manually:** dashboard layout and the Socket.IO live updates, since these change fastest and matter only in the demo.
- **Key behaviors to prove:** a fix that helps is promoted; a fix that does not help is rejected and never reaches production; a risky fix waits for approval; the action cap stops runaway healing.

## Out of Scope

- Real cloud or Kubernetes integration; the demo uses local supervised services.
- Learning-based anomaly detection; detection uses simple thresholds and trends.
- Multi-user accounts, roles and login.
- Paging channels such as SMS, email or chat alerts.
- Healing databases, networks or hardware.
- Production-grade security hardening and scale testing.
- Language-model decisions about which fix to apply.

## Further Notes

### 24-hour plan

| Hours | Deliverable |
| --- | --- |
| 0 to 4 | Demo services, traffic generator, Chaos Injector, data model |
| 4 to 10 | Signal Collector, Incident Detector, Root-Cause Graph |
| 10 to 16 | Fix Catalog, Shadow Verifier, Remediator |
| 16 to 21 | Live Gateway, React dashboard, Receipt Writer |
| 21 to 24 | Demo script, polish, rehearsal |

### Demo script (about 3 minutes)

1. Show the healthy dashboard.
2. Press the Chaos Button on the payments service.
3. Watch the orders service turn red, then the root-cause graph point at payments.
4. Watch the shadow test run, with before and after numbers side by side.
5. See the fix promoted and the dashboard return to green, then open the Heal Receipt.
6. Break a service with a fix that does not help, and show the rollback and escalation.

### Risks and fallbacks

- If shadow replay is not ready by hour 16, ship a simplified replay using a fixed set of recorded requests.
- If real-time updates fail, fall back to dashboard polling.
- Market figures are from third-party surveys; label them as such in any pitch.
