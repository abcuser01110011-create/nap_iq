import React, { useEffect } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { useOffline } from "../../offline/OfflineContext";
import SyncBanner from "../../offline/SyncBanner";
import { colors } from "../../theme/technician";
import { JOB_TYPE_LABELS, STATUS_LABELS } from "./statusLabels";

// Phase 28: an installation assignment has no issue_code equivalent
// (ServiceRequest isn't given a human-facing code) — fall back to the
// subscriber's own code, which Phase 26 already generates at
// registration, before falling back to the raw assignment id.
function jobTitle(item: {
  issue?: { issue_code: string } | null;
  service_request?: { id: number } | null;
  subscriber?: { subscriber_code: string } | null;
  id: number;
}) {
  if (item.issue) return item.issue.issue_code;
  if (item.service_request) return item.subscriber?.subscriber_code ?? `Installation #${item.service_request.id}`;
  return `Job #${item.id}`;
}

// Company's home service area — the same default the admin's Barangay
// picker already falls back to when nothing is typed (see
// app/static/js/tickets.js). Used here so a ticket with no address on
// file still shows something sensible instead of a blank line.
const DEFAULT_ADDRESS = "Sta. Cruz, Laguna";

function jobAddress(item: {
  subscriber?: { address?: string | null } | null;
  issue?: { address?: string | null } | null;
  service_request?: { address?: string | null } | null;
}) {
  return item.subscriber?.address ?? item.issue?.address ?? item.service_request?.address ?? DEFAULT_ADDRESS;
}

// Both a repair (technical_issue.priority) and an installation-type
// Service Order (service_request.priority, added alongside "Add NAP")
// carry a priority now -- prefer whichever one this job actually has.
function jobPriority(item: {
  issue?: { priority?: string | null } | null;
  service_request?: { priority?: string | null } | null;
}) {
  return item.issue?.priority ?? item.service_request?.priority ?? null;
}

export default function AssignmentsScreen({ navigation }: any) {
  const { user } = useAuth();
  const { openAssignments, refreshing, refresh, pendingByAssignment, isOnline } = useOffline();

  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", () => {
      if (isOnline) refresh();
    });
    return unsubscribe;
  }, [navigation, refresh, isOnline]);

  return (
    <View style={styles.screen}>
      <SyncBanner />
      <View style={styles.header}>
        <Text style={styles.greeting}>Hi, {user?.full_name ?? "Technician"}</Text>
        <Text style={styles.count}>{openAssignments.length} open job(s)</Text>
      </View>

      <FlatList
        data={openAssignments}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} enabled={isOnline} />
        }
        ListEmptyComponent={<Text style={styles.empty}>No open assignments right now.</Text>}
        renderItem={({ item }) => {
          const pending = pendingByAssignment[item.id] ?? 0;
          const priority = jobPriority(item);
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() => navigation.navigate("JobDetail", { assignment: item })}
            >
              {/* Line 1: Ticket code. Line 2: Type. Line 3: Address
                  (defaults to the home service area, see
                  DEFAULT_ADDRESS). Line 4: Priority, if this job has
                  one. Status badge sits alongside line 1, not counted
                  as one of the four lines. */}
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{jobTitle(item)}</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{STATUS_LABELS[item.status] ?? item.status}</Text>
                </View>
              </View>
              <View style={styles.jobTypeRow}>
                <Text style={styles.jobTypeTag}>{JOB_TYPE_LABELS[item.job_type] ?? item.job_type}</Text>
              </View>
              <Text style={styles.cardAddress}>{jobAddress(item)}</Text>
              <View style={styles.cardFooter}>
                {priority && <Text style={styles.priority}>Priority: {priority}</Text>}
                {pending > 0 && <Text style={styles.pendingTag}>Queued — will sync</Text>}
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 48 },
  header: { padding: 20 },
  greeting: { color: colors.text, fontSize: 20, fontWeight: "700" },
  count: { color: colors.textFaint, fontSize: 13, marginTop: 2 },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  empty: { color: colors.textFaint, textAlign: "center", marginTop: 40 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  jobTypeRow: { marginTop: 4 },
  jobTypeTag: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardAddress: { color: colors.textFaint, fontSize: 13, marginTop: 6 },
  cardFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  priority: { color: colors.textFaint, fontSize: 12, textTransform: "capitalize" },
  pendingTag: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  badge: {
    backgroundColor: colors.primaryLight,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: "#8FB6FF", fontSize: 12, fontWeight: "600" },
});
