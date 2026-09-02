import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "./src/auth/AuthContext";
import RootNavigator from "./src/navigation/RootNavigator";
import { isRunningInExpoGo } from "./src/notifications/registerPushToken";

// New assignment / status change pushes (technician accounts only —
// see notifications/registerPushToken.ts) should be visible even
// while the app's already open. The default handler suppresses
// foreground alerts, so this opts back in. Harmless to configure
// globally even though only technician sessions ever register a
// token.
//
// IMPORTANT: expo-notifications must never be statically imported at
// the top of this file. This module is the app's entry point, so a
// top-level `import * as Notifications from "expo-notifications"`
// here runs before literally anything else -- and on Android inside
// Expo Go (SDK 53+), just importing that package throws synchronously
// (it registers a push-token listener as a module-level side effect),
// crashing the app on every single launch. Guard + lazy-require here
// instead, matching notifications/registerPushToken.ts and
// notifications/NotificationRouter.tsx.
if (!isRunningInExpoGo()) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Notifications = require("expo-notifications") as typeof import("expo-notifications");
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
  });
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
