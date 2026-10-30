const HEALER = process.env.HEALER_URL ?? "http://localhost:4000";
const DEFAULT_FIX_TYPES = ["restart", "revert_config", "reset_defaults", "apply_stale_snapshot"];
const SERVICES = ["orders", "payments", "inventory"] as const;
const PORTS: Record<(typeof SERVICES)[number], number> = { orders: 4001, payments: 4002, inventory: 4003 };
const TERMINAL = ["resolved", "escalated"];
const INCIDENT_TIMEOUT_MS = 16 * 60_000;
const QUIET_TIMEOUT_MS = 5 * 60_000;

interface Scenario {
  service: (typeof SERVICES)[number];
  fault: "crash" | "slow" | "memory_leak" | "bad_config" | "gray";
  gray?: { rate: number; mode: "error" | "slow" | "mixed" };
  allowedFixTypes?: string[];
  expectState: "resolved" | "escalated";
  expectOutcome: RegExp;
  expectFailure?: string;
  expectImpact?: string;
  expectProductionCorrupt?: boolean;
  requiresApproval?: boolean;
}

const SCENARIOS: Record<string, Scenario> = {
  crash: { service: "payments", fault: "crash", expectState: "resolved", expectOutcome: /fixed by Restart process/ },
  slow: { service: "payments", fault: "slow", expectState: "resolved", expectOutcome: /fixed by Restart process/ },
  memory_leak: {
    service: "inventory",
    fault: "memory_leak",
    expectState: "resolved",
    expectOutcome: /fixed by Restart process/,
  },
  bad_config: {
    service: "payments",
    fault: "bad_config",
    expectState: "resolved",
    expectOutcome: /fixed by Revert config/,
  },
  decoy: {
    service: "payments",
    fault: "bad_config",
    allowedFixTypes: ["apply_stale_snapshot"],
    expectState: "escalated",
    expectOutcome: /no candidate fix was verified/,
    expectProductionCorrupt: true,
  },
  approval: {
    service: "payments",
    fault: "bad_config",
    allowedFixTypes: ["reset_defaults"],
    requiresApproval: true,
    expectState: "resolved",
    expectOutcome: /fixed by Reset to factory defaults/,
  },
  gray: {
    service: "payments",
    fault: "gray",
    gray: { rate: 0.2, mode: "error" },
    expectState: "resolved",
    expectOutcome: /fixed by Restart process/,
    expectFailure: "gray",
    expectImpact: "helped",
  },
  gray_slow: {
    service: "inventory",
    fault: "gray",
    gray: { rate: 0.2, mode: "slow" },
    expectState: "resolved",
    expectOutcome: /fixed by Restart process/,
    expectFailure: "gray",
    expectImpact: "helped",
  },
};

const FLAP_CYCLES = 4;
const FLAP_RETURN_MS = 10_000;

interface Incident {
  id: string;
  state: string;
  rootCause: string | null;
  failure: string | null;
  outcome: string | null;
  openedAt: string;
  recurrenceOf?: string | null;
}

interface AttemptInfo {
  id: string;
  candidate: string;
  label: string;
  verdict: string;
  status: string;
  sampleSize: number;
  reasons: string[];
  impact?: string | null;
  impactReasons?: string[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${HEALER}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
}

async function directCall(port: number, method: string, path: string, body?: unknown): Promise<void> {
  await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQuiet(): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data } = await call<{ activeIncident: Incident | null }>("GET", "/api/state");
    if (!data.activeIncident) return;
    await sleep(2000);
  }
  throw new Error("an earlier incident is still open; wait for it to clear and try again");
}

async function resetEnvironment(scenario: Scenario): Promise<void> {
  for (const service of SERVICES) {
    const allowed = scenario.allowedFixTypes && service === scenario.service ? scenario.allowedFixTypes : DEFAULT_FIX_TYPES;
    await call("POST", "/api/services", { name: service, allowedFixTypes: allowed });
    await directCall(PORTS[service], "PUT", "/config", { mode: "ok" });
    await directCall(PORTS[service], "POST", "/__chaos", { fault: null });
  }
}

async function waitForIncident(startedAt: number, scenario: Scenario): Promise<Incident> {
  const deadline = Date.now() + INCIDENT_TIMEOUT_MS;
  let lastState = "";
  let approved = false;
  while (Date.now() < deadline) {
    const { data: incidents } = await call<Incident[]>("GET", "/api/incidents");
    const incident = incidents.find((entry) => Date.parse(entry.openedAt) >= startedAt - 1000);
    if (incident) {
      if (incident.state !== lastState) {
        console.log(`  incident ${incident.id.slice(0, 8)}: ${incident.state}`);
        lastState = incident.state;
      }
      if (incident.state === "awaiting_approval" && scenario.requiresApproval && !approved) {
        const { data: state } = await call<{ pendingApprovals: string[] }>("GET", "/api/state");
        const attemptId = state.pendingApprovals[0];
        if (attemptId) {
          await call("POST", `/api/approvals/${attemptId}`, { decision: "approve" });
          approved = true;
          console.log("  approved the medium-risk fix in the dashboard API");
        }
      }
      if (TERMINAL.includes(incident.state)) return incident;
    }
    await sleep(2000);
  }
  throw new Error("incident did not reach a terminal state in time");
}

interface Timing {
  detectSeconds: number;
  fixLiveSeconds: number | null;
  confirmedSeconds: number | null;
  humanWaitSeconds: number;
}

type IncidentDetail = Incident & { attempts: AttemptInfo[]; timing?: Timing };

function describeTiming(timing: Timing | undefined): string {
  if (!timing) return "timing unavailable";
  const human = timing.humanWaitSeconds > 0 ? `, ${timing.humanWaitSeconds}s waiting for approval` : ", no human paged";
  const fixLive = timing.fixLiveSeconds !== null ? `fix live ${timing.fixLiveSeconds}s, ` : "no fix applied, ";
  const confirmed = timing.confirmedSeconds !== null ? `closed ${timing.confirmedSeconds}s` : "still open";
  const head = timing.fixLiveSeconds !== null ? `healed in ${timing.fixLiveSeconds}s` : "not healed automatically";
  return `${head} (detect ${timing.detectSeconds}s, ${fixLive}${confirmed}${timing.fixLiveSeconds !== null ? human : ""})`;
}

function describeAttempt(attempt: AttemptInfo): string {
  const impact = attempt.impact ? `, impact ${attempt.impact}: ${(attempt.impactReasons ?? []).join("; ")}` : "";
  return `${attempt.label} -> ${attempt.verdict} (${attempt.status}, ${attempt.sampleSize} samples)${impact}`;
}

function report(name: string, failures: string[]): void {
  if (failures.length > 0) {
    console.log(`[scenario] ${name}: FAIL`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`[scenario] ${name}: PASS`);
}

// A gray fault that comes back every time the healer restarts the service. A good healer
// restarts at most twice, then opens its circuit breaker and hands the problem to a human.
async function runFlap(): Promise<void> {
  const service = "payments";
  const scenario: Scenario = { service, fault: "gray", expectState: "escalated", expectOutcome: /circuit breaker/ };
  console.log(`[scenario] flap: gray fault on ${service} that returns ${FLAP_RETURN_MS / 1000} s after every fix`);
  await call("GET", "/health");
  await waitForQuiet();
  await resetEnvironment(scenario);
  await call("POST", `/api/guard/${service}/reset`);
  await sleep(3000);

  const incidents: Incident[] = [];
  for (let cycle = 1; cycle <= FLAP_CYCLES; cycle += 1) {
    const startedAt = Date.now();
    await call("POST", "/api/chaos", { service, fault: "gray", rate: 0.2, mode: "error" });
    console.log(`  cycle ${cycle}: fault injected`);
    const incident = await waitForIncident(startedAt, scenario);
    incidents.push(incident);
    console.log(`  cycle ${cycle}: ${incident.state}, ${incident.outcome}`);
    if (incident.state === "escalated") break;
    await sleep(FLAP_RETURN_MS);
  }

  const details = await Promise.all(
    incidents.map(async (incident) => (await call<IncidentDetail>("GET", `/api/incidents/${incident.id}`)).data),
  );
  const restarts = details.flatMap((detail) =>
    detail.attempts.filter((attempt) => attempt.candidate === "restart" && ["kept", "rolled_back"].includes(attempt.status)),
  );
  for (const detail of details) {
    for (const attempt of detail.attempts) console.log(`  ${detail.id.slice(0, 8)} attempt: ${describeAttempt(attempt)}`);
    console.log(`  ${detail.id.slice(0, 8)} ${describeTiming(detail.timing)}`);
  }
  const { data: audit } = await call<{ action: string; trigger: string }[]>("GET", "/api/audit");
  const suppressed = audit.filter((entry) => entry.action === "action.suppressed");
  for (const entry of suppressed) console.log(`  suppressed: ${entry.trigger}`);

  const failures: string[] = [];
  const last = incidents[incidents.length - 1];
  if (!last || last.state !== "escalated" || !/circuit breaker/.test(last.outcome ?? "")) {
    failures.push(`expected the last incident to escalate with the circuit breaker, got ${last?.state}: ${last?.outcome}`);
  }
  if (restarts.length > 2) failures.push(`healer restarted ${restarts.length} times; a restart storm`);
  if (suppressed.length === 0) failures.push("no action.suppressed entry in the audit trail");
  if (details[0]?.attempts.find((attempt) => attempt.status === "kept")?.impact !== "temporary") {
    failures.push("the first fix was not revised to temporary after the fault came back");
  }
  if (incidents.length > 1 && !details[1]?.recurrenceOf) failures.push("the second incident was not linked as a recurrence");

  console.log(`  ${restarts.length} restart(s) across ${incidents.length} incident(s)`);
  const { data: scorecard } = await call<Record<string, unknown>>("GET", "/api/scorecard");
  console.log(`  guardrails: ${JSON.stringify(scorecard)}`);
  await resetEnvironment({ ...scenario, allowedFixTypes: undefined });
  await call("POST", `/api/guard/${service}/reset`);
  report("flap", failures);
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (name === "flap") return runFlap();
  const scenario = name ? SCENARIOS[name] : undefined;
  if (!scenario) {
    console.log(`usage: npm run scenario -- <${[...Object.keys(SCENARIOS), "flap"].join("|")}>`);
    process.exit(2);
  }

  console.log(`[scenario] ${name}: ${scenario.fault} on ${scenario.service}`);
  await call("GET", "/health");
  await waitForQuiet();
  await resetEnvironment(scenario);
  await call("POST", `/api/guard/${scenario.service}/reset`);
  await sleep(3000);

  const startedAt = Date.now();
  await call("POST", "/api/chaos", { service: scenario.service, fault: scenario.fault, ...scenario.gray });
  console.log("  fault injected");

  const incident = await waitForIncident(startedAt, scenario);
  const failures: string[] = [];

  if (incident.state !== scenario.expectState) {
    failures.push(`expected state ${scenario.expectState}, got ${incident.state}`);
  }
  if (!scenario.expectOutcome.test(incident.outcome ?? "")) {
    failures.push(`outcome "${incident.outcome}" does not match ${scenario.expectOutcome}`);
  }
  if (incident.rootCause !== scenario.service) {
    failures.push(`expected root cause ${scenario.service}, got ${incident.rootCause}`);
  }

  const detail = await call<IncidentDetail>("GET", `/api/incidents/${incident.id}`);
  for (const attempt of detail.data.attempts) {
    console.log(`  attempt: ${describeAttempt(attempt)}; ${attempt.reasons.join("; ")}`);
  }
  if (scenario.expectFailure && detail.data.failure !== scenario.expectFailure) {
    failures.push(`expected failure type ${scenario.expectFailure}, got ${detail.data.failure}`);
  }
  if (scenario.expectImpact) {
    const kept = detail.data.attempts.find((attempt) => attempt.status === "kept");
    if (kept?.impact !== scenario.expectImpact) {
      failures.push(`expected the applied fix to be judged ${scenario.expectImpact}, got ${kept?.impact}`);
    }
  }

  const receipt = await call<{ text: string; wordedBy: string }>("GET", `/api/receipts/${incident.id}`);
  if (receipt.status !== 200) {
    failures.push("no receipt was written");
  } else if (!receipt.data.text.includes(scenario.service)) {
    failures.push("receipt does not name the root cause");
  }

  if (scenario.expectProductionCorrupt) {
    const response = await fetch(`http://localhost:${PORTS[scenario.service]}/config`);
    const config = (await response.json()) as { mode: string };
    if (config.mode !== "corrupt") {
      failures.push("production config changed, the decoy must never reach production");
    }
  }

  console.log(`  outcome: ${incident.outcome}`);
  console.log(`  ${describeTiming(detail.data.timing)}`);
  if (receipt.status === 200) console.log(`  receipt (${receipt.data.wordedBy}): ${receipt.data.text.split("\n")[0]}`);

  await resetEnvironment({ ...scenario, allowedFixTypes: undefined });
  report(name, failures);
}

main().catch((error) => {
  console.error(`[scenario] error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
