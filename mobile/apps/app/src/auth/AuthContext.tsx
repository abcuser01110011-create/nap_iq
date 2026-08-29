import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { ApiClient, ApiError, type ApiUser, type RegisterInput } from "@nap-iq/api-client";
import { secureTokenStorage } from "./secureTokenStorage";
import { registerPushToken, unregisterPushToken } from "../notifications/registerPushToken";

const USER_KEY = "user_profile";

export type AppRole = "technician" | "customer";

/** Maps the backend's `user.role` value to which half of this app to show. */
function toAppRole(backendRole: string): AppRole | null {
  if (backendRole === "field_assistant") return "technician";
  if (backendRole === "user") return "customer";
  return null;
}

type AuthStatus = "loading" | "signedOut" | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  user: ApiUser | null;
  /** Which half of this single install to render — derived from
   * user.role, not asked for at login. There's no separate "technician
   * app" / "customer app" anymore, so unlike the two standalone apps
   * this used to be, login no longer rejects an otherwise-valid
   * account for being the "wrong" role — it just routes it. */
  role: AppRole | null;
  client: ApiClient;
  login: (username: string, password: string) => Promise<void>;
  /** Phase 30 — pure self-service registration (username + password
   * only). On success behaves exactly like login(): stores the
   * returned tokens/user and flips status to signedIn, landing a
   * brand-new account straight on the dashboard, where "Apply for
   * service" is offered as a next step rather than required up
   * front. */
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  /** Surfaced so the login/register screens can show a friendly
   * message without every screen re-deriving it from ApiError itself. */
  lastError: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<ApiUser | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  // One ApiClient for the app's lifetime. onAuthExpired fires from
  // *inside* a request (e.g. a background assignment fetch) whenever
  // the refresh token itself is no longer valid — that's the single
  // signal that should always force the user back to the login
  // screen, regardless of which screen triggered it.
  const statusRef = useRef(status);
  statusRef.current = status;

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: (Constants.expoConfig?.extra?.apiBaseUrl as string) ?? "",
        tokenStorage: secureTokenStorage,
        onAuthExpired: () => {
          setUser(null);
          setRole(null);
          setStatus("signedOut");
          SecureStore.deleteItemAsync(USER_KEY).catch(() => {});
        },
      }),
    []
  );

  // Restore session on cold start: a stored token pair means we
  // optimistically show the signed-in UI immediately (no login-screen
  // flash), and let the first real request validate/refresh the
  // access token — onAuthExpired above catches an actually-dead
  // refresh token and bounces back to login at that point instead.
  useEffect(() => {
    (async () => {
      const hasSession = await client.hasStoredSession();
      if (!hasSession) {
        setStatus("signedOut");
        return;
      }
      const storedUser = await SecureStore.getItemAsync(USER_KEY);
      let restoredRole: AppRole | null = null;
      if (storedUser) {
        const parsed = JSON.parse(storedUser) as ApiUser;
        restoredRole = toAppRole(parsed.role);
        setUser(parsed);
        setRole(restoredRole);
      }
      setStatus("signedIn");
      // Best-effort — see registerPushToken.ts (gated to technician
      // accounts there).
      registerPushToken(client, restoredRole);
    })();
  }, [client]);

  const login = async (username: string, password: string) => {
    setLastError(null);
    try {
      const result = await client.auth.login(username, password);
      const appRole = toAppRole(result.user.role);
      if (!appRole) {
        // Defense in depth — the backend already refuses to issue a
        // token to anything outside technician/user roles, but this
        // guards against a role value neither half of the app knows
        // how to render.
        await client.auth.logout();
        setLastError("This account type isn't supported in this app.");
        return;
      }
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(result.user));
      setUser(result.user);
      setRole(appRole);
      setStatus("signedIn");
      registerPushToken(client, appRole); // best-effort — see registerPushToken.ts
    } catch (err) {
      if (err instanceof ApiError) {
        setLastError(err.body.error ?? "Couldn't sign in. Please try again.");
      } else {
        setLastError("Couldn't reach the server. Check your connection.");
      }
    }
  };

  const register = async (input: RegisterInput) => {
    setLastError(null);
    try {
      const result = await client.auth.register(input);
      // Always "customer" here in practice (register only ever
      // creates role='user' accounts), but derive it the same way
      // login() does rather than hardcoding it.
      const appRole = toAppRole(result.user.role);
      if (!appRole) {
        await client.auth.logout();
        setLastError("Something went wrong creating your account. Please contact support.");
        return;
      }
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(result.user));
      setUser(result.user);
      setRole(appRole);
      setStatus("signedIn");
      registerPushToken(client, appRole);
    } catch (err) {
      if (err instanceof ApiError) {
        // errors (validation) vs error (single message) — see
        // register()'s two response shapes in api_v1/auth.py.
        const firstFieldError = err.body.errors ? Object.values(err.body.errors)[0] : undefined;
        setLastError(err.body.error ?? firstFieldError ?? "Couldn't create your account. Please try again.");
      } else {
        setLastError("Couldn't reach the server. Check your connection.");
      }
    }
  };

  const logout = async () => {
    await unregisterPushToken(client, role); // best-effort — see registerPushToken.ts
    await client.auth.logout();
    await SecureStore.deleteItemAsync(USER_KEY);
    setUser(null);
    setRole(null);
    setStatus("signedOut");
  };

  return (
    <AuthContext.Provider value={{ status, user, role, client, login, register, logout, lastError }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}