import * as SQLite from "expo-sqlite";

/**
 * Local mirror of just what a tech needs offline (plan §3.2): their
 * assigned jobs (both the "open" and "history" lists the two tabs
 * show) and a pending-actions queue for writes made while offline.
 *
 * Uses expo-sqlite's synchronous API (SDK 51+) — sync reads/writes
 * keep the offline paths simple (no awaiting a DB round-trip just to
 * decide what to render), and SQLite operations here are small/local
 * so the sync calls never block the JS thread noticeably.
 */
const db = SQLite.openDatabaseSync("nap_iq_technician.db");

let initialized = false;

export function initDb(): void {
  if (initialized) return;
  db.execSync(`
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER NOT NULL,
      bucket TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      PRIMARY KEY (id, bucket)
    );
    CREATE TABLE IF NOT EXISTS pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT
    );
  `);
  initialized = true;
}

export default db;
