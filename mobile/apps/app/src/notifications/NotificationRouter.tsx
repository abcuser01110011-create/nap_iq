import { useEffect } from "react";
import { useOffline } from "../offline/OfflineContext";
import { navigationRef } from "../navigation/navigationRef";
import { isRunningInExpoGo } from "./registerPushToken";

/** Mounted inside OfflineProvider (signed-in tree only) so it always
 * has a live `refresh`. New assignment / status change → Expo push
 * (plan §3.2) — this is the device-side half of that: a push landing
 * while the app's open refreshes the Jobs/History cache so it's
 * current without a manual pull-to-refresh, and tapping a push always
 * takes the tech to their job list rather than wherever the app
 * happened to be left open.
 *
 * No-ops entirely inside Expo Go. Important: `expo-notifications` is
 * NOT statically imported at the top of this file anymore. As of
 * SDK 53+, merely importing that module on Android inside Expo Go
 * throws synchronously (it registers a push-token listener as a
 * module-level side effect) -- so a top-level `import` here would
 * crash the app on mount before the isRunningInExpoGo() check below
 * ever ran. Requiring it lazily, only after confirming we're not in
 * Expo Go, avoids that entirely. A development or production build
 * (executionEnvironment: Standalone) still gets full push behavior. */
export default function NotificationRouter() {
  const { refresh, isOnline } = useOffline();

  useEffect(() => {
    if (isRunningInExpoGo()) return;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Notifications = require("expo-notifications") as typeof import("expo-notifications");

    const receivedSub = Notifications.addNotificationReceivedListener(() => {
      if (isOnline) refresh();
    });

    const responseSub = Notifications.addNotificationResponseReceivedListener(() => {
      if (navigationRef.isReady()) {
        navigationRef.navigate("Tabs");
      }
      if (isOnline) refresh();
    });

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, [refresh, isOnline]);

  return null;
}
