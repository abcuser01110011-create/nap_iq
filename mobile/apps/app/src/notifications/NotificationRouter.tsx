import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { useOffline } from "../offline/OfflineContext";
import { navigationRef } from "../navigation/navigationRef";

// Expo Go (SDK 53+) dropped remote push support entirely; avoid wiring up
// push listeners there so this component is a no-op in Expo Go instead of
// throwing, and only listens for real in a dev/standalone build.
const isExpoGo = Constants.executionEnvironment === "storeClient";

/** Mounted inside OfflineProvider (signed-in tree only) so it always
 * has a live `refresh`. New assignment / status change → Expo push
 * (plan §3.2) — this is the device-side half of that: a push landing
 * while the app's open refreshes the Jobs/History cache so it's
 * current without a manual pull-to-refresh, and tapping a push always
 * takes the tech to their job list rather than wherever the app
 * happened to be left open. */
export default function NotificationRouter() {
  const { refresh, isOnline } = useOffline();

  useEffect(() => {
    if (isExpoGo) return;

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
