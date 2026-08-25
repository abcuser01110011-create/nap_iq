import React, { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { ApiError, type ServiceRequest } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";

export default function ServiceRequestsScreen() {
  const { client } = useAuth();
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { service_requests } = await client.customer.listServiceRequests();
      setRequests(service_requests);
    } catch (err) {
      if (err instanceof ApiError) setError(err.body.error ?? "Couldn't load service requests.");
    }
  }, [client]);

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
        <Text style={styles.title}>Service requests</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={requests}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          !loading ? (
            <Text style={styles.empty}>
              No service requests on file. New requests (relocation, upgrade, etc.) are opened by
              PG Networks staff on your behalf for now.
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{item.request_type}</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.status}</Text>
              </View>
            </View>
            {item.requested_nap && (
              <Text style={styles.cardSubtitle}>NAP: {item.requested_nap.nap_code}</Text>
            )}
            {item.notes && (
              <Text style={styles.cardDescription} numberOfLines={2}>
                {item.notes}
              </Text>
            )}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { padding: 20, paddingTop: 56, paddingBottom: 8 },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  error: { color: colors.danger, paddingHorizontal: 20, marginBottom: 8 },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  empty: { color: colors.textMuted, textAlign: "center", marginTop: 24, lineHeight: 20 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: "700", textTransform: "capitalize" },
  cardSubtitle: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
  cardDescription: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
  badge: {
    backgroundColor: colors.primaryLight,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: colors.primary, fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
});
