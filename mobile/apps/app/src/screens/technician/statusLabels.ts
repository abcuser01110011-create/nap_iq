import type { AssignmentStatus } from "@nap-iq/api-client";

// Display labels for the strict state machine documented in
// app/routes/technician.py (assigned -> accepted -> in_progress ->
// completed, or cancelled) — kept here so both the list and detail
// screens render the same wording.
export const STATUS_LABELS: Record<AssignmentStatus, string> = {
  assigned: "Assigned",
  accepted: "Accepted",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

// Phase 28: display labels for ServiceRequest.request_type (see
// database/schema.sql's service_request_type enum). Dispatch only
// ever sends a 'new_installation' request through the assignment flow
// today (see app/routes/dispatch.py's _assert_request_dispatchable()),
// but the other values are mapped too so this doesn't silently render
// a raw enum string if that ever changes.
export const REQUEST_TYPE_LABELS: Record<string, string> = {
  new_installation: "New installation",
  disconnection: "Disconnection",
  relocation: "Relocation",
  upgrade: "Upgrade",
  add_nap: "Nap Installation",
};

// Phase 28: display label for Assignment.job_type ("repair" |
// "installation" — see api-client's AssignmentJobType).
export const JOB_TYPE_LABELS: Record<string, string> = {
  repair: "Repair",
  installation: "Installation",
};

// Same palette, labels, and urgency order as the GeoMap's priority
// markers (app/static/js/napmap.js's PRIORITY_COLORS / PRIORITY_LABELS
// / PRIORITY_RANK) — kept in sync so a priority reads the same color,
// wording, and rank everywhere in the app, not just on the map.
// "low" is tea green rather than gray (matches napmap.js's comment on
// why: it no longer visually disappears against gray UI chrome), and
// "critical" displays as "Urgent" everywhere a priority is shown as
// text -- the raw value ("critical") is unchanged everywhere else
// (API payloads, PRIORITY_RANK, filtering), only the label shown to a
// person differs.
export const PRIORITY_COLORS: Record<string, string> = {
  low: "#d0f0c0",
  medium: "#ffc107",
  high: "#fd7e14",
  critical: "#dc3545",
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Urgent",
};

export const PRIORITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// The admin's "+ Tickets" quick-create form (app/templates/naps/map.html,
// ticketFormModal) labels this same value "Ticket Code" and formats it
// "TN 00006" for a Trouble Ticket (repair) / "SO 00001" for a Service
// Order (installation) — 5-digit, zero-padded, space-separated (see
// app/routes/api.py's tickets_next_code_json). The field assistant's
// dashboard needs to show that same code, not a different convention,
// so this mirrors it exactly from the record's real id.
export function ticketCode(item: {
  issue?: { id: number } | null;
  service_request?: { id: number } | null;
  id: number;
}): string {
  if (item.issue) return `TN ${String(item.issue.id).padStart(5, "0")}`;
  if (item.service_request) return `SO ${String(item.service_request.id).padStart(5, "0")}`;
  return `Job #${item.id}`;
}
