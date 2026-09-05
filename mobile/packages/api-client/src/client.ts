import type { TokenStorage } from "./tokenStorage";
import type {
  ApiErrorBody,
  ApplyInput,
  ApplyResponse,
  LinkAccountInput,
  LinkAccountResponse,
  Assignment,
  CoverageCheckResult,
  CustomerIssue,
  LoginResponse,
  Payment,
  RefreshResponse,
  RegisterInput,
  ReportIssueInput,
  SendVerificationCodeResponse,
  ServiceRequest,
  Subscriber,
  VerifyEmailCodeResponse,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error ?? "Request failed.");
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Thrown when a request needed auth, the refresh token was also
 * rejected, and the caller must re-login. Distinct from ApiError so
 * app code can special-case "kick back to the login screen" without
 * string-matching a message. */
export class AuthExpiredError extends Error {
  constructor() {
    super("Session expired. Please log in again.");
    this.name = "AuthExpiredError";
  }
}

export interface ApiClientConfig {
  /** e.g. "https://napiq.example.com" — no trailing slash. */
  baseUrl: string;
  tokenStorage: TokenStorage;
  /** Fired once when a refresh attempt itself fails (refresh token
   * expired/revoked/missing) — the client has already cleared stored
   * tokens by the time this fires. Wire this to your auth context so
   * the app can redirect to the login screen. */
  onAuthExpired?: () => void;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** false for the three /api/v1/auth/* calls, which manage their own
   * token attachment (login sends none, refresh sends the refresh
   * token, logout sends whichever token it's revoking). Every other
   * endpoint defaults to true. */
  auth?: boolean;
  /** internal — set on the single retry after a silent refresh so we
   * never loop. */
  _isRetry?: boolean;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly tokenStorage: TokenStorage;
  private readonly onAuthExpired?: () => void;
  /** De-dupes concurrent refresh attempts: if five requests all hit a
   * 401 at once, they should all await one refresh call, not fire
   * five refresh requests. */
  private refreshInFlight: Promise<string> | null = null;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.tokenStorage = config.tokenStorage;
    this.onAuthExpired = config.onAuthExpired;
  }

  // ---- low-level request -------------------------------------------------

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, auth = true, _isRetry = false } = options;

    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (auth) {
      const tokens = await this.tokenStorage.getTokens();
      if (tokens?.accessToken) {
        headers.Authorization = `Bearer ${tokens.accessToken}`;
      }
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      throw new ApiError(0, { error: "Couldn't reach the server. Check your connection." });
    }

    if (response.status === 401 && auth && !_isRetry) {
      // Access token expired mid-session — try one silent refresh,
      // then replay this exact request once. Anything past that (a
      // second 401, or the refresh call itself failing) is a real
      // "you need to log in again" state, not a transient blip.
      try {
        await this.refreshAccessTokenDeduped();
      } catch {
        await this.tokenStorage.clear();
        this.onAuthExpired?.();
        throw new AuthExpiredError();
      }
      return this.request<T>(path, { ...options, _isRetry: true });
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Whatever answered wasn't our Flask JSON API at all — a 404
      // HTML page, a proxy/ngrok error page, a dev server's default
      // error screen, etc. Surfacing the real HTTP status here (and a
      // message that says so) instead of throwing a raw, un-caught
      // SyntaxError avoids every caller's catch block generically
      // reporting "couldn't load"/"couldn't save" with no clue that
      // the actual problem was talking to the wrong server/endpoint.
      throw new ApiError(response.status, {
        error: `Server returned a non-JSON response (HTTP ${response.status}). Check that the app is pointed at the right server and that this endpoint is deployed.`,
      });
    }

    if (!response.ok) {
      throw new ApiError(response.status, data as ApiErrorBody);
    }
    return data as T;
  }

  private async refreshAccessTokenDeduped(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const tokens = await this.tokenStorage.getTokens();
      if (!tokens?.refreshToken) throw new AuthExpiredError();

      const response = await fetch(`${this.baseUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.refreshToken}` },
      });
      if (!response.ok) throw new AuthExpiredError();

      const data = (await response.json()) as RefreshResponse;
      await this.tokenStorage.setAccessToken(data.access_token);
      return data.access_token;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  // ---- auth ---------------------------------------------------------------

  readonly auth = {
    /** Exchanges credentials for a token pair and persists them.
     * Throws ApiError(401) on bad credentials, ApiError(403) if the
     * account is deactivated or isn't a technician/customer account. */
    login: async (username: string, password: string): Promise<LoginResponse> => {
      const data = await this.request<LoginResponse>("/api/v1/auth/login", {
        method: "POST",
        auth: false,
        body: { username, password },
      });
      await this.tokenStorage.setTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
      });
      return data;
    },

    /** Self-service registration (Phase 26). Same auto-login shape as
     * login() — a successful register() leaves the caller signed in. */
    register: async (input: RegisterInput): Promise<LoginResponse> => {
      const data = await this.request<LoginResponse>("/api/v1/auth/register", {
        method: "POST",
        auth: false,
        body: input,
      });
      await this.tokenStorage.setTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
      });
      return data;
    },

    /** Revokes both tokens server-side (one call per token, matching
     * app/routes/api_v1/auth.py's logout() docstring) and clears local
     * storage regardless of whether the network calls succeed — a
     * user tapping "log out" should always end up logged out locally,
     * even offline. */
    logout: async (): Promise<void> => {
      const tokens = await this.tokenStorage.getTokens();
      const revoke = async (token: string) => {
        try {
          await fetch(`${this.baseUrl}/api/v1/auth/logout`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch {
          // best-effort — local clear below is what actually logs the
          // device out
        }
      };
      if (tokens?.accessToken) await revoke(tokens.accessToken);
      if (tokens?.refreshToken) await revoke(tokens.refreshToken);
      await this.tokenStorage.clear();
    },
  };

  // ---- technician surface ---------------------------------------------------

  readonly technician = {
    listAssignments: () =>
      this.request<{ assignments: Assignment[] }>("/api/v1/technician/assignments"),

    assignmentHistory: () =>
      this.request<{ assignments: Assignment[] }>("/api/v1/technician/assignments/history"),

    acceptAssignment: (assignmentId: number) =>
      this.request<{ assignment: Assignment }>(
        `/api/v1/technician/assignments/${assignmentId}/accept`,
        { method: "POST" }
      ),

    startAssignment: (assignmentId: number) =>
      this.request<{ assignment: Assignment }>(
        `/api/v1/technician/assignments/${assignmentId}/start`,
        { method: "POST" }
      ),

    /** `portNumber` is optional and, when omitted, leaves whatever
     * port was previously saved untouched — passing `null` explicitly
     * clears it. Mirrors _validate_port_number()'s "missing key vs.
     * blank value" distinction in api_v1/technician.py. */
    saveNotes: (assignmentId: number, resolutionNotes: string, portNumber?: number | null) =>
      this.request<{ assignment: Assignment }>(
        `/api/v1/technician/assignments/${assignmentId}/notes`,
        {
          method: "POST",
          body: {
            resolution_notes: resolutionNotes,
            ...(portNumber !== undefined ? { port_number: portNumber } : {}),
          },
        }
      ),

    completeAssignment: (assignmentId: number, resolutionNotes?: string, portNumber?: number | null) =>
      this.request<{ assignment: Assignment }>(
        `/api/v1/technician/assignments/${assignmentId}/complete`,
        {
          method: "POST",
          body: {
            ...(resolutionNotes !== undefined ? { resolution_notes: resolutionNotes } : {}),
            ...(portNumber !== undefined ? { port_number: portNumber } : {}),
          },
        }
      ),

    /** Registers this device for push (new assignment / status change
     * → Expo push → device, per plan §3.2). Endpoint shape is an
     * assumption pending confirmation against the actual
     * `DeviceToken` route in `api_v1/technician.py` — the plan's
     * §2.3 table adds the model but doesn't pin down the route, so
     * verify this against the backend before relying on it in
     * production. A failed call is always non-fatal to the caller —
     * see `registerPushToken` in the technician app. */
    /** Uploads (or replaces) the required completion photo for an
     * assignment. Sent as multipart/form-data directly via fetch
     * rather than through the shared request() helper above, since a
     * photo isn't JSON — auth is attached the same way request()
     * does it, but unlike request(), a 401 here is NOT silently
     * retried after a refresh; the caller (JobDetailScreen) is
     * expected to just let the person try the upload again. */
    uploadAssignmentPhoto: async (
      assignmentId: number,
      photo: { uri: string; name: string; type: string }
    ): Promise<{ assignment: Assignment }> => {
      const tokens = await this.tokenStorage.getTokens();
      const form = new FormData();
      // React Native's FormData accepts this { uri, name, type } shape
      // directly — it's exactly what expo-image-picker's result gives
      // the caller, so JobDetailScreen can pass it straight through.
      form.append("photo", { uri: photo.uri, name: photo.name, type: photo.type } as unknown as Blob);

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/v1/technician/assignments/${assignmentId}/photo`, {
          method: "POST",
          headers: tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : undefined,
          // No Content-Type header here on purpose — fetch/React
          // Native sets the multipart boundary itself from the
          // FormData body, and overriding it manually breaks the
          // upload.
          body: form,
        });
      } catch {
        throw new ApiError(0, { error: "Couldn't reach the server. Check your connection." });
      }

      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new ApiError(response.status, data as ApiErrorBody);
      }
      return data as { assignment: Assignment };
    },
    /** Uploads (or replaces) the customer sign-off photo for an
     * installation assignment. Mirrors uploadAssignmentPhoto above —
     * multipart/form-data via fetch, auth attached the same way,
     * no silent 401 retry — but posts to the /signature endpoint
     * under the "signature" field name, matching
     * upload_assignment_signature() in api_v1/technician.py. */
    uploadAssignmentSignature: async (
      assignmentId: number,
      signature: { uri: string; name: string; type: string }
    ): Promise<{ assignment: Assignment }> => {
      const tokens = await this.tokenStorage.getTokens();
      const form = new FormData();
      form.append("signature", { uri: signature.uri, name: signature.name, type: signature.type } as unknown as Blob);

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/v1/technician/assignments/${assignmentId}/signature`, {
          method: "POST",
          headers: tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : undefined,
          // No Content-Type header here on purpose — see the same
          // note in uploadAssignmentPhoto above.
          body: form,
        });
      } catch {
        throw new ApiError(0, { error: "Couldn't reach the server. Check your connection." });
      }

      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new ApiError(response.status, data as ApiErrorBody);
      }
      return data as { assignment: Assignment };
    },
    /** Records the technician's own on-site GPS fix for an
     * installation assignment — the replacement for the old
     * customer-signature step above. Plain JSON (no file involved),
     * so this goes through the shared request() helper like
     * saveNotes/completeAssignment rather than a manual fetch()
     * call. */
    pinAssignmentLocation: (assignmentId: number, latitude: number, longitude: number) =>
      this.request<{ assignment: Assignment }>(
        `/api/v1/technician/assignments/${assignmentId}/pin-location`,
        { method: "POST", body: { latitude, longitude } }
      ),
    /** Nearest-suitable-NAP candidates for the assignment's already-
     * pinned on-site location (see pinAssignmentLocation above) — for
     * an installation dispatched with no NAP linked. Mirrors the
     * admin "Recommend NAP" list's shape, nearest first, so the
     * screen can render it directly. 409s server-side if no location
     * has been pinned yet. */
    nearbyNaps: (assignmentId: number) =>
      this.request<{ naps: NearbyNap[] }>(
        `/api/v1/technician/assignments/${assignmentId}/nearby-naps`
      ),
    /** Links the chosen NAP (from nearbyNaps above) to the
     * assignment's installation, the field counterpart to the admin's
     * "Use This NAP" action. Returns the updated assignment — its
     * `nap` field (and therefore the Job Detail screen's port
     * dropdown) is populated from this response without a separate
     * refetch. */
    linkNap: (assignmentId: number, napId: number) =>
      this.request<{ assignment: Assignment }>(
        `/api/v1/technician/assignments/${assignmentId}/link-nap`,
        { method: "POST", body: { nap_id: napId } }
      ),
    registerDeviceToken: (token: string, platform: "ios" | "android") =>
      this.request<{ ok: true }>("/api/v1/technician/device-token", {
        method: "POST",
        body: { token, platform },
      }),

    unregisterDeviceToken: (token: string) =>
      this.request<{ ok: true }>("/api/v1/technician/device-token", {
        method: "DELETE",
        body: { token },
      }),
  };

  // ---- customer surface -------------------------------------------------

  readonly customer = {
    me: () => this.request<{ subscriber: Subscriber }>("/api/v1/customer/me"),

    /** Applies for service on behalf of the signed-in account -- the
     * mobile equivalent of the Apply for Service screen's Step 3
     * submit. Creates the Subscriber + ServiceRequest server-side
     * (see app/routes/api_v1/customer.py's apply()); 409s if this
     * account already has a subscriber on file, 422s if the location
     * turns out to be outside coverage. */
    apply: (input: ApplyInput) =>
      this.request<ApplyResponse>("/api/v1/customer/apply", {
        method: "POST",
        body: input,
      }),

    /** Attaches the signed-in account to an existing subscriber record
     * it already has -- the mobile equivalent of the web portal's
     * "Link Existing Account" form. 409s if this login already has a
     * subscriber on file, 400 with a generic error if the code/phone
     * pair doesn't match anything (see app/routes/api_v1/customer.py's
     * link_account()). */
    linkAccount: (input: LinkAccountInput) =>
      this.request<LinkAccountResponse>("/api/v1/customer/link-account", {
        method: "POST",
        body: input,
      }),

    listIssues: () => this.request<{ issues: CustomerIssue[] }>("/api/v1/customer/issues"),

    /** Self-service issue reporting. Sent as multipart/form-data
     * directly via fetch rather than through the shared request()
     * helper above, since the required photo isn't JSON — mirrors
     * technician.uploadAssignmentPhoto above: auth attached the same
     * way, and a 401 here is likewise NOT silently retried after a
     * refresh; the caller (ReportIssueScreen) is expected to just let
     * the person retry the submit. */
    reportIssue: async (input: ReportIssueInput): Promise<{ issue: CustomerIssue }> => {
      const tokens = await this.tokenStorage.getTokens();
      const form = new FormData();
      form.append("issue_type", input.issue_type);
      if (input.priority) form.append("priority", input.priority);
      form.append("description", input.description);
      // React Native's FormData accepts this { uri, name, type } shape
      // directly — same as uploadAssignmentPhoto above.
      form.append("photo", { uri: input.photo.uri, name: input.photo.name, type: input.photo.type } as unknown as Blob);

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/v1/customer/issues`, {
          method: "POST",
          headers: tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : undefined,
          // No Content-Type header here on purpose — see the same
          // note in uploadAssignmentPhoto above.
          body: form,
        });
      } catch {
        throw new ApiError(0, { error: "Couldn't reach the server. Check your connection." });
      }

      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new ApiError(response.status, data as ApiErrorBody);
      }
      return data as { issue: CustomerIssue };
    },

    listServiceRequests: () =>
      this.request<{ service_requests: ServiceRequest[] }>("/api/v1/customer/service-requests"),

listPayments: () => this.request<{ payments: Payment[] }>("/api/v1/customer/payments"),
  };

  // ---- public (pre-login) surface — Phase 26 -----------------------------

  readonly public = {
    checkCoverage: (latitude: number, longitude: number) =>
      this.request<CoverageCheckResult>("/api/v1/customer/coverage-check", {
        method: "POST",
        auth: false,
        body: { latitude, longitude },
      }),

    listPlans: () =>
      this.request<{ plans: string[] }>("/api/v1/customer/plans", { auth: false }),

    /** Sends a 6-digit one-time code to `email` via Gmail SMTP
     * (app/email_utils.py). Always resolves — the backend deliberately
     * never reveals whether the address is already registered, so a
     * thrown ApiError here only ever means a malformed email or a
     * rate limit, not "that email is taken". */
    sendVerificationCode: (email: string) =>
      this.request<SendVerificationCodeResponse>("/api/v1/auth/send-verification-code", {
        method: "POST",
        auth: false,
        body: { email },
      }),

    /** Checks the code the applicant typed against the most recently
     * sent one. Throws ApiError(400) with a specific message (expired
     * / wrong / too many attempts / none requested) on failure — show
     * `error.message` directly, it's already user-facing copy from
     * app/email_utils.py's verify_code(). */
    verifyEmailCode: (email: string, code: string) =>
      this.request<VerifyEmailCodeResponse>("/api/v1/auth/verify-email-code", {
        method: "POST",
        auth: false,
        body: { email, code },
      }),
  };

  /** True once a token pair is stored locally. Doesn't verify the
   * access token is still valid server-side — that's discovered on
   * the first authenticated request, same as any JWT client. */
  async hasStoredSession(): Promise<boolean> {
    const tokens = await this.tokenStorage.getTokens();
    return tokens !== null;
  }
}