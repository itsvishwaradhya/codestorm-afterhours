import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { AuditEntry, Incident, Receipt, ServiceName, Snapshot } from "@nightshift/shared";
import { api, type HealthState, type ImpactSummary, type IncidentDetail, type Scorecard } from "./api.ts";

const LIVE_CHANNELS = ["snapshot", "incident", "attempt", "receipt", "audit"];
const HISTORY_POINTS = 40;

export type SnapshotHistory = Partial<Record<ServiceName, Snapshot[]>>;

export function useDashboard() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [impact, setImpact] = useState<ImpactSummary | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [history, setHistory] = useState<SnapshotHistory>({});
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Snapshots arrive both over the socket and in each refresh; keep a short rolling
  // window per service, de-duplicated by timestamp, for the sparklines.
  const pushSnapshots = useCallback((snapshots: Snapshot[]) => {
    setHistory((previous) => {
      const next: SnapshotHistory = { ...previous };
      for (const snapshot of snapshots) {
        const list = next[snapshot.service] ?? [];
        if (list.length > 0 && list[list.length - 1].at >= snapshot.at) continue;
        next[snapshot.service] = [...list, snapshot].slice(-HISTORY_POINTS);
      }
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [state, incidentList, auditList, impactSummary, scores] = await Promise.all([
        api.state(),
        api.incidents(),
        api.audit(),
        api.impact(),
        api.scorecard(),
      ]);
      setHealth(state);
      setImpact(impactSummary);
      setScorecard(scores);
      setIncidents(incidentList);
      setAudit(auditList.slice(0, 80));
      pushSnapshots(state.snapshots);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "the healer is not reachable");
    } finally {
      setLoaded(true);
    }
  }, [pushSnapshots]);

  useEffect(() => {
    void refresh();
    const socket = io();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    };
    socket.on("connect", () => {
      setConnected(true);
      schedule();
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("snapshot", (snapshot: Snapshot) => pushSnapshots([snapshot]));
    for (const channel of LIVE_CHANNELS) {
      socket.on(channel, schedule);
    }
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      socket.disconnect();
    };
  }, [refresh, pushSnapshots]);

  return { health, incidents, audit, impact, scorecard, history, connected, loaded, error, refresh };
}

export function useIncidentDetail(id: string | null, stamp: unknown) {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(false);
  const shownId = useRef<string | null>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      setReceipt(null);
      shownId.current = null;
      return;
    }
    // Only show the skeleton when switching incidents, not on every live refresh.
    if (shownId.current !== id) setLoading(true);
    let cancelled = false;
    Promise.all([api.incident(id), api.receipt(id)])
      .then(([incident, found]) => {
        if (!cancelled) {
          setDetail(incident);
          setReceipt(found);
          shownId.current = id;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, stamp]);

  return { detail: detail && detail.id === id ? detail : null, receipt, loading };
}
