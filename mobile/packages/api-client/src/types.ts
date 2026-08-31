/**
 * Types mirror app/routes/api_v1/*.py's actual serializers exactly
 * (read from the backend source, not the original plan doc — a couple
 * of endpoint names/shapes drifted during implementation: customer
 * profile is GET /me, not /profile; there's no POST service-requests
 * or technician /naps /route yet). Keep these in sync with
 * _serialize_assignment / _serialize_subscriber / _serialize_issue /
 * _serialize_service_request / _serialize_payment whenever the
 * backend changes shape.
 */

export type MobileRole = "technician" | "user";

export interface ApiUser {
  id: number;
  username: string;
  full_name: string;
  role: MobileRole;
  email: string | null;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: ApiUser;
}

export interface RefreshResponse {
  access_token: string;
}

export interface ApiErrorBody {
  error?: string;
  errors?: Record<string, string>;
}

// ---- Technician surface --------------------------------------------------

export type AssignmentStatus =
  | "assigned"
  | "accepted"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface AssignmentIssue {
  id: number;
  issue_code: string;
  issue_type: string;
  description: string;
  priority: string;
  status: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface AssignmentSubscriber {
  id: number;
  subscriber_code: string;
  full_name: string;
  address: string | null;
  contact_number: string | null;
  latitude: number | null;
  longitude: number | null;
}

// Phase 28 (installation dispatch) + GeoMap "+ Tickets" walk-in Service
// Orders: full_name/address/contact_number are the request's own copy
// of the applicant's details, only ever populated when there's no
// linked Subscriber (a walk-in whose Customer field was typed as free
// text, never matched against `subscribers`). The mobile app falls
// back to these when `Assignment.subscriber` below is null -- see
// AssignmentsScreen.tsx/JobDetailScreen.tsx.
export interface AssignmentServiceRequest {
  id: number;
  request_type: string;
  status: string;
  priority: "low" | "medium" | "high" | "critical" | null;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  full_name: string | null;
  address: string | null;
  contact_number: string | null;
}

export interface AssignmentNap {
  id: number;
  nap_code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** Drives the mobile Job Detail screen's port dropdown — valid
   * options are 1..total_ports (see _validate_port_number() in
   * api_v1/technician.py). */
  total_ports: number;
}

export interface Assignment {
  id: number;
  status: AssignmentStatus;
  /** "repair" for a technical_issue-sourced assignment, "installation"
   * for a service_request-sourced one. */
  job_type: "repair" | "installation";
  assigned_at: string | null;
  completed_at: string | null;
  resolution_notes: string | null;
  /** The NAP port the field assistant serviced, chosen from the Job
   * Detail screen's dropdown (1..nap.total_ports). Null until set;
   * always null for an assignment with no linked NAP. */
  port_number: number | null;
  /** Absolute URL to the technician's required completion photo, or
   * null until one's been uploaded. Set via
   * ApiClient.technician.uploadAssignmentPhoto(). */
  photo_url: string | null;
  /** Absolute URL to the customer's install signature (installations
   * only), or null until one's been uploaded. No longer required for
   * completion (superseded by pin_latitude/pin_longitude below), but
   * still returned for any already-recorded sign-offs. */
  signature_url: string | null;
  /** The technician's own on-site GPS fix for an installation,
   * captured via ApiClient.technician.pinAssignmentLocation() —
   * required (in place of a signature) before an installation can be
   * marked complete. Null until pinned; always null for a repair. */
  pin_latitude: number | null;
  pin_longitude: number | null;
  issue: AssignmentIssue | null;
  service_request: AssignmentServiceRequest | null;
  subscriber: AssignmentSubscriber | null;
  nap: AssignmentNap | null;
}

// ---- Customer surface -----------------------------------------------------

export interface SubscriberNapRef {
  id: number;
  nap_code: string;
  name: string;
}

export interface Subscriber {
  id: number;
  subscriber_code: string;
  full_name: string;
  address: string | null;
  contact_number: string | null;
  email: string | null;
  plan_type: string | null;
  status: string;
  installed_at: string | null;
  nap: SubscriberNapRef | null;
}

export interface CustomerIssue {
  id: number;
  issue_code: string;
  issue_type: string;
  description: string;
  priority: string;
  status: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface ReportIssueInput {
  issue_type: string;
  priority?: "low" | "medium" | "high" | "critical";
  description: string;
}

export interface ServiceRequest {
  id: number;
  request_type: string;
  status: string;
  notes: string | null;
  created_at: string | null;
  requested_nap: SubscriberNapRef | null;
}

export interface Payment {
  id: number;
  amount: number | null;
  payment_method: string;
  payment_date: string | null;
  reference_number: string | null;
  status: string;
}

export interface RegisterInput {
  username: string;
  password: string;
  full_name: string;
  email?: string;
  phone_number?: string;
  latitude: number;
  longitude: number;
  address?: string;
  plan_name?: string;
}

/** Body for ApiClient.customer.apply() -- POST /api/v1/customer/apply.
 * Runs for an already signed-in account (unlike RegisterInput, which
 * creates the account itself), so there's no username/password here. */
export interface ApplyInput {
  full_name: string;
  email?: string;
  phone_number?: string;
  latitude: number;
  longitude: number;
  address?: string;
  plan_name?: string;
}

export interface ApplyResponse {
  subscriber: Subscriber;
}

export interface SendVerificationCodeResponse {
  message: string;
}

export interface VerifyEmailCodeResponse {
  message: string;
  verified: true;
}

export interface CoverageCheckResult {
  available: boolean;
  nearest_nap_code?: string;
  distance_km?: number;
}