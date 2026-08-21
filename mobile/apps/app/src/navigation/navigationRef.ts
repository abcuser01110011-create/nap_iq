import { createNavigationContainerRef } from "@react-navigation/native";
import type { TechnicianStackParamList } from "./RootNavigator";

// Only the technician stack is pushed to — push notifications are
// technician-only (see notifications/registerPushToken.ts).
export const navigationRef = createNavigationContainerRef<TechnicianStackParamList>();
