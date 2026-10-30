import { describe, expect, it } from "vitest";
import type { Incident, IncidentState } from "@nightshift/shared";
import { healTiming } from "../src/report/timing.js";

const T0 = Date.parse("2026-10-30T06:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function incident(history: [IncidentState, number][], overrides: Partial<Incident> = {}): Incident {
  const terminal = history.find(([state]) => state === "resolved" || state === "escalated");
  return {
    id: "incident-1",
    state: terminal?.[0] ?? history[history.length - 1][0],
    rootCause: "payments",
    symptoms: ["orders"],
    causes: [],
    anomalies: [{ service: "payments", kind: "unreachable", value: 0, threshold: 1, since: at(0) }],
    failure: "crash",
    pendingApprovalId: null,
    stateHistory: history.map(([state, seconds]) => ({ state, at: at(seconds) })),
    openedAt: at(2),
    closedAt: terminal ? at(terminal[1]) : null,
    outcome: null,
    ...overrides,
  };
}

describe("heal timing", () => {
  it("measures detection, fix live and confirmation from the first bad sample", () => {
    const timing = healTiming(
      incident([
        ["detected", 2],
        ["diagnosed", 2],
        ["verifying", 4],
        ["promoting", 14.5],
        ["watching", 16],
        ["resolved", 76],
      ]),
    );
    expect(timing.firstBadAt).toBe(at(0));
    expect(timing.detectSeconds).toBe(2);
    expect(timing.fixLiveSeconds).toBe(16);
    expect(timing.confirmedSeconds).toBe(76);
    expect(timing.humanWaitSeconds).toBe(0);
    expect(timing.phases).toEqual([
      { state: "detected", seconds: 0 },
      { state: "diagnosed", seconds: 2 },
      { state: "verifying", seconds: 10.5 },
      { state: "promoting", seconds: 1.5 },
      { state: "watching", seconds: 60 },
    ]);
  });

  it("reports the time spent waiting for a human", () => {
    const timing = healTiming(
      incident([
        ["detected", 2],
        ["diagnosed", 2],
        ["verifying", 4],
        ["awaiting_approval", 12],
        ["promoting", 42],
        ["watching", 43],
        ["resolved", 103],
      ]),
    );
    expect(timing.humanWaitSeconds).toBe(30);
    expect(timing.fixLiveSeconds).toBe(43);
  });

  it("has no fix-live time when nothing reached production", () => {
    const timing = healTiming(
      incident([
        ["detected", 2],
        ["diagnosed", 2],
        ["verifying", 4],
        ["escalated", 20],
      ]),
    );
    expect(timing.fixLiveSeconds).toBeNull();
    expect(timing.confirmedSeconds).toBe(20);
  });

  it("falls back to the open time when there are no anomalies, and handles an open incident", () => {
    const timing = healTiming(incident([["detected", 2], ["diagnosed", 2], ["verifying", 4]], { anomalies: [] }));
    expect(timing.firstBadAt).toBe(at(2));
    expect(timing.detectSeconds).toBe(0);
    expect(timing.confirmedSeconds).toBeNull();
    expect(timing.phases).toEqual([
      { state: "detected", seconds: 0 },
      { state: "diagnosed", seconds: 2 },
    ]);
  });
});
