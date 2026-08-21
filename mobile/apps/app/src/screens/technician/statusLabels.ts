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
