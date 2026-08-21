import type { Assignment } from "@nap-iq/api-client";
import db from "./db";
import type { AssignmentBucket } from "./types";

/** Replaces the full cached snapshot for a bucket ("open" tab's list
 * or "history" tab's list) — used after a successful network fetch. */
export function saveAssignments(bucket: AssignmentBucket, assignments: Assignment[]): void {
  const now = new Date().toISOString();
  db.withTransactionSync(() => {
    db.runSync(`DELETE FROM assignments WHERE bucket = ?`, [bucket]);
    for (const a of assignments) {
      db.runSync(
        `INSERT OR REPLACE INTO assignments (id, bucket, status, data, cached_at) VALUES (?, ?, ?, ?, ?)`,
        [a.id, bucket, a.status, JSON.stringify(a), now]
      );
    }
  });
}

export function loadAssignments(bucket: AssignmentBucket): Assignment[] {
  const rows = db.getAllSync<{ data: string }>(
    `SELECT data FROM assignments WHERE bucket = ? ORDER BY id DESC`,
    [bucket]
  );
  return rows.map((r) => JSON.parse(r.data) as Assignment);
}

export function getFromBucket(bucket: AssignmentBucket, id: number): Assignment | null {
  const row = db.getFirstSync<{ data: string }>(
    `SELECT data FROM assignments WHERE bucket = ? AND id = ?`,
    [bucket, id]
  );
  return row ? (JSON.parse(row.data) as Assignment) : null;
}

/** Updates (or inserts) a single cached assignment — used for
 * optimistic local writes and for applying a synced server response,
 * without re-fetching the whole list. */
export function upsertSingleAssignment(bucket: AssignmentBucket, assignment: Assignment): void {
  db.runSync(
    `INSERT OR REPLACE INTO assignments (id, bucket, status, data, cached_at) VALUES (?, ?, ?, ?, ?)`,
    [assignment.id, bucket, assignment.status, JSON.stringify(assignment), new Date().toISOString()]
  );
}

export function removeFromBucket(bucket: AssignmentBucket, id: number): void {
  db.runSync(`DELETE FROM assignments WHERE bucket = ? AND id = ?`, [bucket, id]);
}
