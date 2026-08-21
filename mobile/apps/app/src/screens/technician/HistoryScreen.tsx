import React, { useEffect } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useOffline } from "../../offline/OfflineContext";
import SyncBanner from "../../offline/SyncBanner";
import { colors } from "../../theme/technician";
import { STATUS_LABELS } from "./statusLabels";

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
              <Text style={styles.cardTitle}>{item.issue?.issue_code ?? `Job #${item.id}`}</Text>
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
