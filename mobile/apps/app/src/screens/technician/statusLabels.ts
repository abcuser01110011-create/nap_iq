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

// Same palette and urgency order as the GeoMap's priority markers
// (app/static/js/napmap.js's PRIORITY_COLORS / PRIORITY_RANK) — kept
// in sync so a priority reads the same color and ranks the same way
// everywhere in the app, not just on the map.
export const PRIORITY_COLORS: Record<string, string> = {
  low: "#22c55e",
  medium: "#ffc107",
  high: "#fd7e14",
  critical: "#dc3545",
};

// Display text shown for each priority key -- separate from the
// underlying key itself (still "low"/"medium"/"high"/"critical"
// everywhere in the data/filtering/API logic) so relabeling here
// never touches PRIORITY_RANK/COLORS lookups keyed by the original
// names. Mirrors the GeoMap's PRIORITY_LABELS (napmap.js), where
// "critical" reads "URGENT" on the map/legend.
export const PRIORITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Urgent",
};

// Fiber Break's forced-critical priority is the whole NAP being down,
// not an individual complaint, so it reads "Critical" instead of the
// "Urgent" label every other critical-priority ticket gets -- same
// exception napmap.js's formatPriorityLabel() applies on the admin
// GeoMap and app/routes/technician.py's _serialize_job() applies on
// the technician web dashboard. Kept here so the mobile app agrees
// with both. `issueType` is optional: pass it whenever it's known
// (an installation/service_request has no issue_type at all, so this
// still falls back to the plain PRIORITY_LABELS lookup for those).
export function priorityLabel(priority?: string | null, issueType?: string | null): string {
  if (issueType === "Fiber Break" && priority === "critical") return "Critical";
  return (priority && PRIORITY_LABELS[priority]) || priority || "";
}

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
