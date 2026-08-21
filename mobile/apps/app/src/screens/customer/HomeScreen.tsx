import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError, type CustomerIssue, type Payment, type ServiceRequest, type Subscriber } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";

const OPEN_ISSUE_STATUSES = new Set(["pending", "assigned", "accepted", "in_progress"]);
const PENDING_REQUEST_STATUSES = new Set(["pending", "approved", "scheduled"]);

export default function HomeScreen() {
  const { client, user } = useAuth();
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [issues, setIssues] = useState<CustomerIssue[]>([]);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ subscriber }, { issues }, { service_requests }, { payments }] = await Promise.all([
        client.customer.me(),
        client.customer.listIssues(),
        client.customer.listServiceRequests(),
        client.customer.listPayments(),
      ]);
      setSubscriber(subscriber);
      setIssues(issues);
      setRequests(service_requests);
      setPayments(payments);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.body.error ?? "Couldn't load your account.");
      }
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openIssueCount = issues.filter((i) => OPEN_ISSUE_STATUSES.has(i.status)).length;
  const pendingRequestCount = requests.filter((r) => PENDING_REQUEST_STATUSES.has(r.status)).length;
  const lastPayment = payments[0];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.greeting}>Hi, {user?.full_name ?? "there"}</Text>
      {error && <Text style={styles.error}>{error}</Text>}

      {subscriber && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Account</Text>
          <Text style={styles.cardValue}>{subscriber.subscriber_code}</Text>
          <View style={styles.row}>
            <View>
              <Text style={styles.rowLabel}>Plan</Text>
              <Text style={styles.rowValue}>{subscriber.plan_type ?? "—"}</Text>
            </View>
            <View>
              <Text style={styles.rowLabel}>Status</Text>
              <Text style={styles.rowValue}>{subscriber.status}</Text>
            </View>
            <View>
              <Text style={styles.rowLabel}>NAP</Text>
              <Text style={styles.rowValue}>{subscriber.nap?.nap_code ?? "—"}</Text>
            </View>
          </View>
        </View>
      )}

      <View style={styles.statsRow}>
        <View style={[styles.statCard, styles.statPrimary]}>
          <Text style={styles.statValue}>{openIssueCount}</Text>
          <Text style={styles.statLabel}>Open issues</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{pendingRequestCount}</Text>
          <Text style={styles.statLabel}>Pending requests</Text>
        </View>
      </View>

      {lastPayment && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Last payment</Text>
          <Text style={styles.cardValue}>
            {lastPayment.amount !== null ? `₱${lastPayment.amount.toFixed(2)}` : "—"}
          </Text>
          <Text style={styles.rowLabel}>
            {lastPayment.payment_method} · {lastPayment.status}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingTop: 56, paddingBottom: 40 },
  greeting: { color: colors.text, fontSize: 22, fontWeight: "700", marginBottom: 16 },
  error: { color: colors.danger, marginBottom: 12 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  cardLabel: { color: colors.textMuted, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  cardValue: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: 4, marginBottom: 12 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  rowLabel: { color: colors.textMuted, fontSize: 12 },
  rowValue: { color: colors.text, fontSize: 14, fontWeight: "600", marginTop: 2, textTransform: "capitalize" },
  statsRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statPrimary: { backgroundColor: colors.primaryLight, borderColor: colors.primaryLight },
  statValue: { color: colors.text, fontSize: 24, fontWeight: "800" },
  statLabel: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
});
