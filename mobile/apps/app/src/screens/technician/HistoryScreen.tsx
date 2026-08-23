import React, { useEffect } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useOffline } from "../../offline/OfflineContext";
import SyncBanner from "../../offline/SyncBanner";
import { colors } from "../../theme/technician";
import { JOB_TYPE_LABELS, STATUS_LABELS } from "./statusLabels";

// Phase 28: same fallback as AssignmentsScreen's jobTitle() — an
// installation has no issue_code equivalent, so fall back to the
// subscriber's own code before the raw assignment id.
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

export default function HistoryScreen({ navigation }: any) {
  const { historyAssignments, refreshing, refresh, isOnline } = useOffline();

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
        <Text style={styles.title}>History</Text>
      </View>

      <FlatList
        data={historyAssignments}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} enabled={isOnline} />
        }
        ListEmptyComponent={<Text style={styles.empty}>No completed jobs yet.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() => navigation.navigate("JobDetail", { assignment: item })}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{jobTitle(item)}</Text>
              <View
                style={[
                  styles.badge,
                  item.status === "cancelled" && { backgroundColor: colors.dangerLight },
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    item.status === "cancelled" && { color: colors.danger },
                  ]}
                >
                  {STATUS_LABELS[item.status] ?? item.status}
                </Text>
              </View>
            </View>
            <Text style={styles.jobTypeTag}>{JOB_TYPE_LABELS[item.job_type] ?? item.job_type}</Text>
            <Text style={styles.cardSubtitle}>{item.subscriber?.full_name ?? "—"}</Text>
            {item.completed_at && (
              <Text style={styles.cardDate}>
                Completed {new Date(item.completed_at).toLocaleDateString()}
              </Text>
            )}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 48 },
  header: { padding: 20 },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  empty: { color: colors.textFaint, textAlign: "center", marginTop: 40 },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, marginBottom: 12 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  jobTypeTag: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 4,
  },
  cardSubtitle: { color: colors.textMuted, fontSize: 14, marginTop: 4 },
  cardDate: { color: colors.textFaint, fontSize: 12, marginTop: 8 },
  badge: {
    backgroundColor: colors.primaryLight,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: "#8FB6FF", fontSize: 12, fontWeight: "600" },
});
