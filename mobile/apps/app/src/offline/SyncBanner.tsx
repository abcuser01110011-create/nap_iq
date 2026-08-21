import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";
import { useOffline } from "./OfflineContext";

/** Sits at the top of the Jobs/History tabs. Silent when everything's
 * up to date so it doesn't nag on every screen. */
export default function SyncBanner() {
  const { isOnline, pendingCount } = useOffline();

  if (isOnline && pendingCount === 0) return null;

  return (
    <View style={[styles.banner, !isOnline && styles.offline]}>
      <Text style={styles.text}>
        {!isOnline
          ? pendingCount > 0
            ? `Offline — ${pendingCount} change${pendingCount === 1 ? "" : "s"} will sync when you're back online`
            : "Offline — showing your last saved jobs"
          : `Syncing ${pendingCount} change${pendingCount === 1 ? "" : "s"}…`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.primaryLight,
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  offline: {
    backgroundColor: colors.dangerLight,
  },
  text: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
});
