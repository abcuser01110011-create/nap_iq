import type { Assignment } from "@nap-iq/api-client";
import type { PendingActionPayload, PendingActionType } from "./types";

/**
 * Mirrors the server-side status machine (`assigned -> accepted ->
 * in_progress -> completed`, from technician.py's docstring) so the
 * UI reflects a queued action immediately, offline or not. The
 * server response that eventually confirms the sync overwrites this
 * with the real record — this is only ever a local placeholder.
 */
export function applyOptimistic(
  assignment: Assignment,
  action: PendingActionType,
  payload: PendingActionPayload | null
): Assignment {
  switch (action) {
    case "accept":
      return { ...assignment, status: "accepted" };
    case "start":
      return { ...assignment, status: "in_progress" };
    case "notes":
      return {
        ...assignment,
        resolution_notes: payload?.resolution_notes ?? assignment.resolution_notes,
        port_number: payload?.port_number !== undefined ? payload.port_number : assignment.port_number,
      };
    case "complete":
      return {
        ...assignment,
        status: "completed",
        resolution_notes: payload?.resolution_notes ?? assignment.resolution_notes,
        port_number: payload?.port_number !== undefined ? payload.port_number : assignment.port_number,
        completed_at: assignment.completed_at ?? new Date().toISOString(),
      };
    default:
      return assignment;
  }
}
