import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import NetInfo from "@react-native-community/netinfo";
import { ApiError, AuthExpiredError, type ApiClient, type Assignment } from "@nap-iq/api-client";
import { useAuth } from "../auth/AuthContext";
import { initDb } from "./db";
import * as assignmentsRepo from "./assignmentsRepo";
import * as queueRepo from "./pendingActionsRepo";
import { applyOptimistic } from "./optimistic";
import type { PendingAction, PendingActionType } from "./types";

const SYNC_INTERVAL_MS = 30_000;

interface OfflineContextValue {
  ready: boolean;
  isOnline: boolean;
  openAssignments: Assignment[];
  historyAssignments: Assignment[];
  refreshing: boolean;
  /** Number of writes still waiting to reach the server. */
  pendingCount: number;
  /** assignmentId -> count of its own queued writes still pending. */
  pendingByAssignment: Record<number, number>;
  /** assignmentId -> the error message from a queued action the
   * server rejected (e.g. the job moved on server-side in a way that
   * makes the queued write invalid) — plan §3.2's conflict handling. */
  conflicts: Record<number, string>;
  refresh: () => Promise<void>;
  syncNow: () => Promise<void>;
  dismissConflict: (assignmentId: number) => void;
  getAssignment: (id: number) => Assignment | undefined;
  acceptJob: (id: number) => void;
  startJob: (id: number) => void;
  saveNotes: (id: number, notes: string) => void;
  completeJob: (id: number, notes?: string) => void;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

async function callRemote(client: ApiClient, action: PendingAction): Promise<Assignment> {
  switch (action.action) {
    case "accept":
      return (await client.technician.acceptAssignment(action.assignmentId)).assignment;
    case "start":
      return (await client.technician.startAssignment(action.assignmentId)).assignment;
    case "notes":
      return (await client.technician.saveNotes(action.assignmentId, action.payload?.resolution_notes ?? ""))
        .assignment;
    case "complete":
      return (await client.technician.completeAssignment(action.assignmentId, action.payload?.resolution_notes))
        .assignment;
  }
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const { client } = useAuth();
  const [ready, setReady] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [openAssignments, setOpenAssignments] = useState<Assignment[]>([]);
  const [historyAssignments, setHistoryAssignments] = useState<Assignment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingByAssignment, setPendingByAssignment] = useState<Record<number, number>>({});
  const [conflicts, setConflicts] = useState<Record<number, string>>({});
  const syncingRef = useRef(false);
  const clientRef = useRef(client);
  clientRef.current = client;

  // Load whatever's on disk immediately, before any network call —
  // this is what makes the app usable offline from a cold start.
  useEffect(() => {
    initDb();
    setOpenAssignments(assignmentsRepo.loadAssignments("open"));
    setHistoryAssignments(assignmentsRepo.loadAssignments("history"));
    refreshPendingState();
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refreshPendingState() {
    const pending = queueRepo.listPendingActions().filter((a) => a.status === "pending");
    setPendingCount(pending.length);
    const byAssignment: Record<number, number> = {};
    for (const p of pending) {
      byAssignment[p.assignmentId] = (byAssignment[p.assignmentId] ?? 0) + 1;
    }
    setPendingByAssignment(byAssignment);
  }

  const applyServerResult = useCallback((updated: Assignment) => {
    if (updated.status === "completed" || updated.status === "cancelled") {
      assignmentsRepo.removeFromBucket("open", updated.id);
      assignmentsRepo.upsertSingleAssignment("history", updated);
      setOpenAssignments((prev) => prev.filter((a) => a.id !== updated.id));
      setHistoryAssignments((prev) => [updated, ...prev.filter((a) => a.id !== updated.id)]);
    } else {
      assignmentsRepo.upsertSingleAssignment("open", updated);
      setOpenAssignments((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    }
    setConflicts((prev) => {
      if (!(updated.id in prev)) return prev;
      const next = { ...prev };
      delete next[updated.id];
      return next;
    });
  }, []);

  /** Drains the queue oldest-first. A rejection from the server (bad
   * status transition, job reassigned, validation error — anything
   * that isn't a connectivity problem) drops that one action and
   * surfaces a conflict rather than retrying it forever; a network
   * failure stops the whole run so it can retry as a unit later. */
  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = queueRepo.listPendingActions().find((a) => a.status === "pending");
        if (!next) break;
        try {
          const updated = await callRemote(clientRef.current, next);
          queueRepo.removeAction(next.id);
          applyServerResult(updated);
        } catch (err) {
          if (err instanceof AuthExpiredError) {
            break; // AuthContext handles bouncing back to the login screen
          }
          if (err instanceof ApiError && err.status !== 0) {
            queueRepo.markActionFailed(
              next.id,
              err.body.error ?? "This job's status changed on the server — please review it."
            );
            setConflicts((prev) => ({
              ...prev,
              [next.assignmentId]:
                err.body.error ?? "This job's status changed on the server — please review it.",
            }));
            continue; // this one's done (failed); keep draining the rest
          }
          break; // status 0 (offline) or anything unexpected — stop, retry later
        }
      }
    } finally {
      syncingRef.current = false;
      refreshPendingState();
    }
  }, [applyServerResult]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      setIsOnline((prevOnline) => {
        if (online && !prevOnline) syncNow();
        return online;
      });
    });
    return unsubscribe;
  }, [syncNow]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (isOnline) syncNow();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isOnline, syncNow]);

  const refresh = useCallback(async () => {
    if (!isOnline) return;
    setRefreshing(true);
    try {
      const [openRes, historyRes] = await Promise.all([
        clientRef.current.technician.listAssignments(),
        clientRef.current.technician.assignmentHistory(),
      ]);
      assignmentsRepo.saveAssignments("open", openRes.assignments);
      assignmentsRepo.saveAssignments("history", historyRes.assignments);
      setOpenAssignments(openRes.assignments);
      setHistoryAssignments(historyRes.assignments);
    } catch {
      // Offline or a transient error — the cached lists already on
      // screen stay as-is rather than being cleared.
    } finally {
      setRefreshing(false);
    }
  }, [isOnline]);

  useEffect(() => {
    if (ready && isOnline) {
      refresh();
      syncNow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const enqueue = useCallback(
    (assignmentId: number, action: PendingActionType, payload: PendingAction["payload"]) => {
      setOpenAssignments((prev) => {
        const current = prev.find((a) => a.id === assignmentId) ?? assignmentsRepo.getFromBucket("open", assignmentId);
        if (!current) return prev;
        const optimistic = applyOptimistic(current, action, payload);
        assignmentsRepo.upsertSingleAssignment("open", optimistic);
        const exists = prev.some((a) => a.id === assignmentId);
        return exists ? prev.map((a) => (a.id === assignmentId ? optimistic : a)) : [optimistic, ...prev];
      });
      queueRepo.enqueueAction(assignmentId, action, payload);
      refreshPendingState();
      if (isOnline) syncNow();
    },
    [isOnline, syncNow]
  );

  const getAssignment = useCallback(
    (id: number) => openAssignments.find((a) => a.id === id) ?? historyAssignments.find((a) => a.id === id),
    [openAssignments, historyAssignments]
  );

  const dismissConflict = useCallback((assignmentId: number) => {
    setConflicts((prev) => {
      const next = { ...prev };
      delete next[assignmentId];
      return next;
    });
  }, []);

  const value = useMemo<OfflineContextValue>(
    () => ({
      ready,
      isOnline,
      openAssignments,
      historyAssignments,
      refreshing,
      pendingCount,
      pendingByAssignment,
      conflicts,
      refresh,
      syncNow,
      dismissConflict,
      getAssignment,
      acceptJob: (id) => enqueue(id, "accept", null),
      startJob: (id) => enqueue(id, "start", null),
      saveNotes: (id, notes) => enqueue(id, "notes", { resolution_notes: notes }),
      completeJob: (id, notes) => enqueue(id, "complete", notes ? { resolution_notes: notes } : null),
    }),
    [
      ready,
      isOnline,
      openAssignments,
      historyAssignments,
      refreshing,
      pendingCount,
      pendingByAssignment,
      conflicts,
      refresh,
      syncNow,
      dismissConflict,
      getAssignment,
      enqueue,
    ]
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error("useOffline must be used within an OfflineProvider");
  return ctx;
}
