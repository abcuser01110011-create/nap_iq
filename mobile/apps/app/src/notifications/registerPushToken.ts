import { Platform } from "react-native";
import * as Device from "expo-device";
import Constants, { ExecutionEnvironment } from "expo-constants";
import type { ApiClient } from "@nap-iq/api-client";

// SDK 53+ removed Android remote-push support from Expo Go entirely.
// Critically, the throw doesn't wait for a specific API call --
// expo-notifications registers a push-token listener as a *module-level*
// side effect, so merely `import`-ing the package on Android inside Expo
// Go throws synchronously and crashes the app before any of our own
// guard checks below ever get a chance to run (see the "runtime not
// ready" / warnOfExpoGoPushUsage stack trace). A static top-level
// `import * as Notifications from "expo-notifications"` would trigger
// that immediately, every time this file loads -- so instead we only
// `require` it lazily, and only when we've already confirmed we're not
// inside Expo Go.
type NotificationsModule = typeof import("expo-notifications");

export function isRunningInExpoGo(): boolean {
  return Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

function getNotifications(): NotificationsModule | null {
  if (isRunningInExpoGo()) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("expo-notifications") as NotificationsModule;
}

function getProjectId(): string | undefined {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof projectId === "string" && projectId.length > 0 ? projectId : undefined;
}

async function resolveExpoPushToken(): Promise<string | null> {
  // Push tokens don't resolve on simulators/emulators — only real
  // devices have an APNs/FCM identity to hand back. Also unavailable
  // in Expo Go on Android as of SDK 53+ (see isRunningInExpoGo above).
  const Notifications = getNotifications();
  if (!Device.isDevice || !Notifications) return null;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = getProjectId();
  const tokenResponse = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined
  );
  return tokenResponse.data;
}

/** Best-effort — called after login and on cold-start session
 * restore. A failure here (permission denied, no EAS project id
 * configured yet, a network blip) just means this device won't
 * receive pushes until the next successful attempt; it should never
 * block sign-in or surface an error to the user.
 *
 * `role` gates this to technician accounts — push was only ever
 * scoped to the technician half of the plan (§3.2), and the
 * device-token endpoints live under `client.technician.*` on the
 * backend, so a customer account has nothing to register against. */
export async function registerPushToken(client: ApiClient, role?: "technician" | "customer" | null): Promise<void> {
  if (role !== "technician") return;
  try {
    const token = await resolveExpoPushToken();
    if (!token) return;
    await client.technician.registerDeviceToken(token, Platform.OS === "ios" ? "ios" : "android");
  } catch {
    // best-effort, same posture as ApiClient.auth.logout's token revoke
  }
}

/** Best-effort unregister on logout — mirrors registerPushToken's
 * failure posture and the same technician-only gate. */
export async function unregisterPushToken(client: ApiClient, role?: "technician" | "customer" | null): Promise<void> {
  if (role !== "technician") return;
  try {
    const Notifications = getNotifications();
    if (!Notifications) return;
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted" || !Device.isDevice) return;
    const projectId = getProjectId();
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    await client.technician.unregisterDeviceToken(tokenResponse.data);
  } catch {
    // best-effort
  }
}
