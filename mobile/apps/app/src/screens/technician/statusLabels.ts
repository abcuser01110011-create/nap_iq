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
  add_nap: "Add NAP",
};

// Phase 28: display label for Assignment.job_type ("repair" |
// "installation" — see api-client's AssignmentJobType).
export const JOB_TYPE_LABELS: Record<string, string> = {
  repair: "Repair",
  installation: "Installation",
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
