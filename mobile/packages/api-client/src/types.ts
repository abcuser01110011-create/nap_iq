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

export interface AssignmentNap {
  id: number;
  nap_code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

export interface Assignment {
  id: number;
  status: AssignmentStatus;
  assigned_at: string | null;
  completed_at: string | null;
  resolution_notes: string | null;
  /** Absolute URL to the technician's required completion photo, or
   * null until one's been uploaded. Set via
   * ApiClient.technician.uploadAssignmentPhoto(). */
  photo_url: string | null;
  issue: AssignmentIssue | null;
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
