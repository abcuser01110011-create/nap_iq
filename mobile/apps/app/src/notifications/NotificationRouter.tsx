import { useEffect } from "react";
import * as Notifications from "expo-notifications";
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
 * No-ops entirely inside Expo Go: as of SDK 53+, Expo Go on Android
 * dropped remote-push support, and touching these listener APIs there
 * throws synchronously instead of just failing silently. A
 * development or production build (executionEnvironment: Standalone)
 * still gets full push behavior as before. */
export default function NotificationRouter() {
  const { refresh, isOnline } = useOffline();

  useEffect(() => {
    if (isRunningInExpoGo()) return;

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
