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
};

// Phase 28: display label for Assignment.job_type ("repair" |
// "installation" — see api-client's AssignmentJobType).
export const JOB_TYPE_LABELS: Record<string, string> = {
  repair: "Repair",
  installation: "Installation",
};
