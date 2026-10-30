import { useCallback, useEffect, useState } from "react";
import { io } from "socket.io-client";
import type { AuditEntry, Incident, Receipt } from "@nightshift/shared";
import { api, type HealthState, type IncidentDetail } from "./api.ts";

const LIVE_CHANNELS = ["snapshot", "incident", "attempt", "receipt", "audit"];

export function useDashboard() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [state, incidentList, auditList] = await Promise.all([api.state(), api.incidents(), api.audit()]);
      setHealth(state);
      setIncidents(incidentList);
      setAudit(auditList.slice(0, 40));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "the healer is not reachable");
    }
  }, []);

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
    for (const channel of LIVE_CHANNELS) {
      socket.on(channel, schedule);
    }
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      socket.disconnect();
    };
  }, [refresh]);

  return { health, incidents, audit, connected, error, refresh };
}

export function useIncidentDetail(id: string | null, stamp: unknown) {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      setReceipt(null);
      return;
    }
    let cancelled = false;
    Promise.all([api.incident(id), api.receipt(id)])
      .then(([incident, found]) => {
        if (!cancelled) {
          setDetail(incident);
          setReceipt(found);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, stamp]);

  return { detail, receipt };
}
