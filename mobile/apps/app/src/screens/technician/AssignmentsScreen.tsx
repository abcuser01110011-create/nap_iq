import React, { useEffect } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import { useOffline } from "../../offline/OfflineContext";
import SyncBanner from "../../offline/SyncBanner";
import { colors } from "../../theme/technician";
import { STATUS_LABELS } from "./statusLabels";

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
          return (
            <TouchableOpacity
              style={styles.card}
              onPress={() => navigation.navigate("JobDetail", { assignment: item })}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{item.issue?.issue_code ?? `Job #${item.id}`}</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{STATUS_LABELS[item.status] ?? item.status}</Text>
                </View>
              </View>
              <Text style={styles.cardSubtitle}>{item.subscriber?.full_name ?? "—"}</Text>
              <Text style={styles.cardAddress}>{item.subscriber?.address ?? item.issue?.address}</Text>
              <View style={styles.cardFooter}>
                {item.issue?.priority && (
                  <Text style={styles.priority}>Priority: {item.issue.priority}</Text>
                )}
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
  cardSubtitle: { color: colors.textMuted, fontSize: 14, marginTop: 4 },
  cardAddress: { color: colors.textFaint, fontSize: 13, marginTop: 2 },
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
