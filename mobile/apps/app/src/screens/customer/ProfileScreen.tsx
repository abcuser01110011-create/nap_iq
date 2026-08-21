import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ApiError, type Subscriber } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const { client, user, logout } = useAuth();
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { subscriber } = await client.customer.me();
      setSubscriber(subscriber);
    } catch (err) {
      if (err instanceof ApiError) setError(err.body.error ?? "Couldn't load your profile.");
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Profile</Text>
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Account</Text>
        <Row label="Name" value={user?.full_name ?? "—"} />
        <Row label="Username" value={user?.username ?? "—"} />
        <Row label="Email" value={user?.email ?? "—"} />
      </View>

      {subscriber && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Subscriber</Text>
          <Row label="Subscriber code" value={subscriber.subscriber_code} />
          <Row label="Address" value={subscriber.address ?? "—"} />
          <Row label="Contact number" value={subscriber.contact_number ?? "—"} />
          <Row label="Plan" value={subscriber.plan_type ?? "—"} />
          <Row label="Status" value={subscriber.status} />
          <Row
            label="Installed"
            value={
              subscriber.installed_at ? new Date(subscriber.installed_at).toLocaleDateString() : "—"
            }
          />
          {subscriber.nap && <Row label="NAP" value={`${subscriber.nap.nap_code} — ${subscriber.nap.name}`} />}
        </View>
      )}

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
  error: { color: colors.danger, marginBottom: 12 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  cardLabel: {
    color: colors.textMuted,
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
  rowLabel: { color: colors.textMuted, fontSize: 14 },
  rowValue: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  logoutButton: {
    backgroundColor: colors.dangerLight,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  logoutText: { color: colors.danger, fontSize: 15, fontWeight: "700" },
});
