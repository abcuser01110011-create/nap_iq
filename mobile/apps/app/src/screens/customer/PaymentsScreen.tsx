import React, { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { ApiError, type Payment } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";

export default function PaymentsScreen() {
  const { client } = useAuth();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { payments } = await client.customer.listPayments();
      setPayments(payments);
    } catch (err) {
      if (err instanceof ApiError) setError(err.body.error ?? "Couldn't load payment history.");
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
        <Text style={styles.title}>Payment history</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={payments}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          !loading ? <Text style={styles.empty}>No payments on file yet.</Text> : null
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.amount}>
                {item.amount !== null ? `₱${item.amount.toFixed(2)}` : "—"}
              </Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.status}</Text>
              </View>
            </View>
            <Text style={styles.method}>{item.payment_method}</Text>
            <View style={styles.footerRow}>
              <Text style={styles.footerText}>
                {item.payment_date ? new Date(item.payment_date).toLocaleDateString() : "—"}
              </Text>
              {item.reference_number && (
                <Text style={styles.footerText}>Ref: {item.reference_number}</Text>
              )}
            </View>
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
  amount: { color: colors.text, fontSize: 18, fontWeight: "800" },
  method: { color: colors.textMuted, fontSize: 13, marginTop: 4, textTransform: "capitalize" },
  footerRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10 },
  footerText: { color: colors.textFaint, fontSize: 12 },
  badge: {
    backgroundColor: colors.primaryLight,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: colors.primary, fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
});
