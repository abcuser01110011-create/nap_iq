import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { useOffline } from "../../offline/OfflineContext";
import { colors } from "../../theme/technician";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const { isOnline, pendingCount, syncNow } = useOffline();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Profile</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Account</Text>
        <Row label="Name" value={user?.full_name ?? "—"} />
        <Row label="Username" value={user?.username ?? "—"} />
        <Row label="Email" value={user?.email ?? "—"} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Sync</Text>
        <Row label="Connection" value={isOnline ? "Online" : "Offline"} />
        <Row label="Waiting to sync" value={String(pendingCount)} />
        {pendingCount > 0 && (
          <TouchableOpacity
            style={styles.syncButton}
            onPress={syncNow}
            disabled={!isOnline}
          >
            <Text style={[styles.syncButtonText, !isOnline && styles.syncButtonTextDisabled]}>
              {isOnline ? "Sync now" : "Will sync when back online"}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* There's no GET /api/v1/technician/me on the backend yet —
          only the assignments endpoints exist in api_v1/technician.py
          — so technician-specific fields (status, resolved job count,
          contact number, live location) aren't shown here. Add a
          backend "me" endpoint mirroring api_v1/customer.py's before
          building this section out further. */}

      <TouchableOpacity style={styles.logoutButton} onPress={logout}>
        <Text style={styles.logoutText}>Log out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingTop: 56, paddingBottom: 60 },
  title: { color: colors.text, fontSize: 22, fontWeight: "700", marginBottom: 16 },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, marginBottom: 16 },
  cardLabel: {
    color: colors.textFaint,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowLabel: { color: colors.textFaint, fontSize: 14 },
  rowValue: { color: colors.text, fontSize: 14, fontWeight: "600" },
  syncButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  syncButtonText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
  syncButtonTextDisabled: { color: colors.textFaint },
  logoutButton: {
    backgroundColor: colors.dangerLight,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  logoutText: { color: colors.danger, fontSize: 15, fontWeight: "700" },
});
