/**
 * The four writes a tech can make against an assignment (plan §3.2 —
 * accept job, save notes, mark complete — plus "start", which is part
 * of the same status machine). Every one of these becomes a queued
 * row instead of firing immediately, so it works offline.
 */
export type PendingActionType = "accept" | "start" | "notes" | "complete";

export interface PendingActionPayload {
  resolution_notes?: string;
}

export interface PendingAction {
  id: number;
  assignmentId: number;
  action: PendingActionType;
  payload: PendingActionPayload | null;
  createdAt: string;
  status: "pending" | "failed";
  lastError: string | null;
}

export type AssignmentBucket = "open" | "history";
