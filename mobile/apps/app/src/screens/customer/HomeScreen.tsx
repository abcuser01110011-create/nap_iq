import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ApiError, type CustomerIssue, type Payment, type ServiceRequest, type Subscriber } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";
import type { CustomerStackParamList } from "../../navigation/RootNavigator";

const OPEN_ISSUE_STATUSES = new Set(["pending", "assigned", "accepted", "in_progress"]);
const PENDING_REQUEST_STATUSES = new Set(["pending", "approved", "scheduled"]);

// Phase 29 (auto-activation): the four stages a self-registered
// application moves through, in order, mirroring
// ServiceRequest.status's own enum (database/schema.sql) minus
// 'rejected' — that one's handled as its own distinct state below
// rather than a step on this track, since a rejected application
// isn't "further along", it's stopped.
const INSTALL_STEPS: { key: string; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Installed" },
];

function StatusTracker({ status }: { status: string }) {
  const currentIndex = INSTALL_STEPS.findIndex((s) => s.key === status);
  return (
    <View style={styles.trackerRow}>
      {INSTALL_STEPS.map((step, i) => {
        const reached = currentIndex >= 0 && i <= currentIndex;
        const isLast = i === INSTALL_STEPS.length - 1;
        return (
          <View key={step.key} style={styles.trackerStep}>
            <View style={styles.trackerDotRow}>
              <View style={[styles.trackerDot, reached && styles.trackerDotActive]} />
              {!isLast && <View style={[styles.trackerLine, reached && styles.trackerLineActive]} />}
            </View>
            <Text style={[styles.trackerLabel, reached && styles.trackerLabelActive]}>{step.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

// Phase 29: what to say under the tracker for each stage — kept
// separate from the tracker itself so the wording can be customer-
// friendly without cluttering StatusTracker's layout logic.
const STEP_MESSAGES: Record<string, string> = {
  pending: "We're reviewing your application. This usually only takes a day or two.",
  approved: "Your application was approved — we'll schedule a technician to install your service soon.",
  scheduled: "A technician has been scheduled for your installation. We'll notify you once it's done.",
  completed: "Your installation is complete — refresh to see your account.",
};

function PendingApplicationCard({
  subscriber,
  installRequest,
}: {
  subscriber: Subscriber;
  installRequest: ServiceRequest | null;
}) {
  if (installRequest?.status === "rejected") {
    return (
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Application status</Text>
        <Text style={styles.cardValue}>Not approved</Text>
        <Text style={styles.trackerMessage}>
          Your application wasn't approved. Please contact PG Networks support for details.
        </Text>
      </View>
    );
  }

  const status = installRequest?.status ?? "pending";

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>Application status</Text>
      <Text style={styles.cardValue}>{subscriber.subscriber_code}</Text>
      <StatusTracker status={status} />
      <Text style={styles.trackerMessage}>{STEP_MESSAGES[status] ?? STEP_MESSAGES.pending}</Text>
    </View>
  );
}

// Phase 30: shown instead of an error whenever the signed-in account
// has no subscriber yet — a perfectly normal state now that
// registration no longer requires applying for service up front,
// not a failure to recover from.
function NoSubscriberCard({ onApply }: { onApply: () => void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>Service</Text>
      <Text style={styles.cardValue}>You're not subscribed yet</Text>
      <Text style={styles.trackerMessage}>
        Your account is all set. Apply for service whenever you're ready to get connected.
      </Text>
      <TouchableOpacity style={styles.applyButton} onPress={onApply}>
        <Text style={styles.applyButtonText}>Apply for service</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function HomeScreen() {
  const { client, user } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<CustomerStackParamList>>();
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [issues, setIssues] = useState<CustomerIssue[]>([]);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error`: a 404 from client.customer.me() just means
  // "no subscriber on file yet", which is an expected state for a
  // freshly-registered account now, not something to show as an error.
  const [noSubscriber, setNoSubscriber] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setNoSubscriber(false);
    try {
      const { subscriber } = await client.customer.me();
      setSubscriber(subscriber);

      // Only fetch the rest of the dashboard once we know there's a
      // subscriber to fetch it for — these all 404 the same way me()
      // does otherwise.
      const [{ issues }, { service_requests }, { payments }] = await Promise.all([
        client.customer.listIssues(),
        client.customer.listServiceRequests(),
        client.customer.listPayments(),
      ]);
      setIssues(issues);
      setRequests(service_requests);
      setPayments(payments);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setSubscriber(null);
        setIssues([]);
        setRequests([]);
        setPayments([]);
        setNoSubscriber(true);
      } else if (err instanceof ApiError) {
        setError(err.body.error ?? "Couldn't load your account.");
      }
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-check whenever the Apply for service screen closes (whether it
  // just created the application or the person backed out) so a
  // freshly-submitted application shows up without a manual pull-to-
  // refresh.
  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", load);
    return unsubscribe;
  }, [navigation, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openIssueCount = issues.filter((i) => OPEN_ISSUE_STATUSES.has(i.status)).length;
  const pendingRequestCount = requests.filter((r) => PENDING_REQUEST_STATUSES.has(r.status)).length;
  const lastPayment = payments[0];

  const isPendingReview = subscriber?.status === "pending_review";
  // Phase 29: `requests` comes back newest-first (Subscriber.service_
  // requests' own ordering — see app/models.py), so the *last*
  // 'new_installation' entry is the original one register()/apply()
  // created — the one whose lifecycle the tracker follows, even if the
  // customer has since filed other request types.
  const installRequests = requests.filter((r) => r.request_type === "new_installation");
  const installRequest = installRequests.length > 0 ? installRequests[installRequests.length - 1] : null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.greeting}>Hi, {user?.full_name ?? "there"}</Text>
      {error && <Text style={styles.error}>{error}</Text>}

      {noSubscriber ? (
        <NoSubscriberCard onApply={() => navigation.navigate("ApplyForService")} />
      ) : isPendingReview && subscriber ? (
        <PendingApplicationCard subscriber={subscriber} installRequest={installRequest} />
      ) : (
        <>
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
        </>
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
  trackerRow: { flexDirection: "row", marginTop: 4, marginBottom: 4 },
  trackerStep: { flex: 1, alignItems: "flex-start" },
  trackerDotRow: { flexDirection: "row", alignItems: "center", width: "100%" },
  trackerDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.border,
  },
  trackerDotActive: { backgroundColor: colors.primary },
  trackerLine: { flex: 1, height: 2, backgroundColor: colors.border, marginHorizontal: 4 },
  trackerLineActive: { backgroundColor: colors.primary },
  trackerLabel: { color: colors.textFaint, fontSize: 11, marginTop: 6, fontWeight: "600" },
  trackerLabelActive: { color: colors.primary },
  trackerMessage: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 12 },
  applyButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  applyButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
});
