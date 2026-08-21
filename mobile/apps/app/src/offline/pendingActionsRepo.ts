import db from "./db";
import type { PendingAction, PendingActionPayload, PendingActionType } from "./types";

function fromRow(row: {
  id: number;
  assignment_id: number;
  action: string;
  payload: string | null;
  created_at: string;
  status: string;
  last_error: string | null;
}): PendingAction {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    action: row.action as PendingActionType,
    payload: row.payload ? (JSON.parse(row.payload) as PendingActionPayload) : null,
    createdAt: row.created_at,
    status: row.status as PendingAction["status"],
    lastError: row.last_error,
  };
}

/** Appends a write to the queue — every offline write (accept, start,
 * save notes, complete) lands here instead of firing immediately
 * (plan §3.2's "pending-actions queue"). */
export function enqueueAction(
  assignmentId: number,
  action: PendingActionType,
  payload: PendingActionPayload | null
): PendingAction {
  const now = new Date().toISOString();
  const result = db.runSync(
    `INSERT INTO pending_actions (assignment_id, action, payload, created_at, status) VALUES (?, ?, ?, ?, 'pending')`,
    [assignmentId, action, payload ? JSON.stringify(payload) : null, now]
  );
  return {
    id: result.lastInsertRowId,
    assignmentId,
    action,
    payload,
    createdAt: now,
    status: "pending",
    lastError: null,
  };
}

/** Ordered oldest-first — the sync engine replays the queue in the
 * order actions were made, one row at a time (plan §3.2). */
export function listPendingActions(): PendingAction[] {
  const rows = db.getAllSync<any>(`SELECT * FROM pending_actions ORDER BY id ASC`);
  return rows.map(fromRow);
}

export function removeAction(id: number): void {
  db.runSync(`DELETE FROM pending_actions WHERE id = ?`, [id]);
}

export function markActionFailed(id: number, error: string): void {
  db.runSync(`UPDATE pending_actions SET status = 'failed', last_error = ? WHERE id = ?`, [error, id]);
}
