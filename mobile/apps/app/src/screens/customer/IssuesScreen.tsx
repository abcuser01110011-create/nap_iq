import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ApiError, type CustomerIssue } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";

const STATUS_COLORS: Record<string, string> = {
  pending: "#B54708",
  assigned: "#175CD3",
  accepted: "#175CD3",
  in_progress: "#175CD3",
  resolved: "#027A48",
  cancelled: "#667085",
};

// Typed loosely (navigation prop from the parent Stack bubbles up
// from this Tab screen) rather than importing RootNavigator's param
// list here, to avoid a screens -> navigation -> screens import cycle.
export default function IssuesScreen({ navigation }: any) {
  const { client } = useAuth();
  const [issues, setIssues] = useState<CustomerIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { issues } = await client.customer.listIssues();
      setIssues(issues);
    } catch (err) {
      if (err instanceof ApiError) setError(err.body.error ?? "Couldn't load your issues.");
    }
  }, [client]);

  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", load);
    return unsubscribe;
  }, [navigation, load]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Your issues</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={issues}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          !loading ? <Text style={styles.empty}>No issues reported yet.</Text> : null
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{item.issue_code}</Text>
              <View
                style={[
                  styles.badge,
                  { backgroundColor: (STATUS_COLORS[item.status] ?? colors.textMuted) + "22" },
                ]}
              >
                <Text
                  style={[styles.badgeText, { color: STATUS_COLORS[item.status] ?? colors.textMuted }]}
                >
                  {item.status.replace("_", " ")}
                </Text>
              </View>
            </View>
            <Text style={styles.cardSubtitle}>{item.issue_type}</Text>
            <Text style={styles.cardDescription} numberOfLines={2}>
              {item.description}
            </Text>
          </View>
        )}
      />

      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate("ReportIssue")}>
        <Text style={styles.fabText}>+ Report issue</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { padding: 20, paddingTop: 56, paddingBottom: 8 },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  error: { color: colors.danger, paddingHorizontal: 20, marginBottom: 8 },
  list: { paddingHorizontal: 20, paddingBottom: 100 },
  empty: { color: colors.textMuted, textAlign: "center", marginTop: 24 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  cardSubtitle: { color: colors.textMuted, fontSize: 14, marginTop: 4, textTransform: "capitalize" },
  cardDescription: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 28,
    backgroundColor: colors.primary,
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 14,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  fabText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
});
