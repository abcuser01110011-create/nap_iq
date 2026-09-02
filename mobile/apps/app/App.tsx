import React from "react";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "./src/auth/AuthContext";
import RootNavigator from "./src/navigation/RootNavigator";

// New assignment / status change pushes (technician accounts only —
// see notifications/registerPushToken.ts) should be visible even
// while the app's already open. The default handler suppresses
// foreground alerts, so this opts back in. Harmless to configure
// globally even though only technician sessions ever register a
// token.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
