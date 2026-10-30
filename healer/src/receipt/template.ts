import type { ReceiptFacts } from "./facts.js";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function failureSentence(facts: ReceiptFacts): string {
  const root = facts.rootCause ?? "the service";
  const anomalies = facts.anomalies.filter((anomaly) => anomaly.service === facts.rootCause);
  if (anomalies.some((anomaly) => anomaly.kind === "unreachable")) {
    return `${root} stopped responding`;
  }
  if (facts.failure === "bad_config") {
    return `${root} was running with a corrupt configuration`;
  }
  if (facts.failure === "memory_leak") {
    const memory = anomalies.find((anomaly) => anomaly.kind === "memory");
    return `${root} memory grew to ${Math.round(memory?.value ?? 0)} MB`;
  }
  if (facts.failure === "gray") {
    const gray = anomalies.find((anomaly) => anomaly.kind === "gray");
    return `${root} kept passing its health check while ${percent(gray?.value ?? 0)} of requests failed or ran slow`;
  }
  if (facts.failure === "slow") {
    const latency = anomalies.find((anomaly) => anomaly.kind === "latency");
    return `${root} p95 latency reached ${Math.round(latency?.value ?? 0)} ms`;
  }
  return `${root} was failing`;
}

export function draftReceipt(facts: ReceiptFacts): string {
  if (!facts.rootCause) {
    return `No root cause was identified. Outcome: ${facts.outcome ?? "open"}.`;
  }

  const lines: string[] = [];
  lines.push(`What broke: ${failureSentence(facts)}.`);

  const cause = facts.causes.find((entry) => entry.service === facts.rootCause);
  lines.push(`Why: ${cause?.reason ?? facts.rootCause}.`);

  if (facts.symptoms.length > 0) {
    lines.push(`Services that looked broken but were not the cause: ${facts.symptoms.join(", ")}.`);
  }

  if (facts.candidates.length === 0) {
    lines.push(
      facts.state === "resolved"
        ? "No fix was applied; the anomalies cleared on their own."
        : "No fix was tried.",
    );
  } else {
    lines.push("Fixes tried:");
    for (const candidate of facts.candidates) {
      lines.push(
        `- ${candidate.label} (${candidate.risk} risk): ${candidate.verdict}, status ${candidate.status}. ${candidate.reasons.join("; ")}.`,
      );
    }
  }

  if (facts.before) {
    lines.push(
      `Before the fix: error rate ${percent(facts.before.errorRate)}, p95 latency ${Math.round(facts.before.p95LatencyMs)} ms.`,
    );
  }
  if (facts.after) {
    lines.push(
      `After the fix (production): error rate ${percent(facts.after.errorRate)}, p95 latency ${Math.round(facts.after.p95LatencyMs)} ms.`,
    );
  }
  const acted = facts.candidates.find((candidate) => candidate.impact);
  if (acted?.impact) {
    lines.push(`Did the action help: ${acted.impact.replace(/_/g, " ")}. ${acted.impactReasons.join("; ")}.`);
  }
  if (facts.recurrenceOf) {
    lines.push(`This fault came back after an earlier fix (incident ${facts.recurrenceOf.slice(0, 8)}).`);
  }

  const duration = facts.durationSeconds !== null ? ` Duration: ${facts.durationSeconds} seconds.` : "";
  lines.push(`Outcome: ${facts.outcome ?? "open"}.${duration}`);
  return lines.join("\n");
}
