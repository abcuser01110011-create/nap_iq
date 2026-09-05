import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { ApiError } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";

// The mobile counterpart to app/templates/customer/link_account.html --
// same two fields, same "both must match or you get one generic error"
// behavior (see app/routes/api_v1/customer.py's link_account()), so a
// self-registered account that already has service from before can
// reconnect the two on either platform.
export default function LinkAccountScreen({ navigation }: any) {
  const { client } = useAuth();
  const [subscriberCode, setSubscriberCode] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const canSubmit = subscriberCode.trim().length > 0 && contactNumber.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await client.customer.linkAccount({
        subscriber_code: subscriberCode.trim(),
        contact_number: contactNumber.trim(),
      });
      navigation.goBack();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.body.errors) {
          setFieldErrors(err.body.errors);
        } else {
          setError(err.body.error ?? "Couldn't link your account. Please try again.");
        }
      } else {
        setError("Couldn't reach the server. Check your connection.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Link existing account</Text>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.cancel}>Cancel</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.intro}>
          Enter your PG Networks subscriber account number and the phone number on file for
          that account. We use both together to confirm it's really yours before linking it to
          this login.
        </Text>

        {error && <Text style={styles.error}>{error}</Text>}

        <Text style={styles.label}>Subscriber account number</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. SUB-0123"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="characters"
          autoFocus
          value={subscriberCode}
          onChangeText={setSubscriberCode}
        />
        {fieldErrors.subscriber_code && (
          <Text style={styles.fieldError}>{fieldErrors.subscriber_code}</Text>
        )}

        <Text style={styles.label}>Phone number on file</Text>
        <TextInput
          style={styles.input}
          placeholder="Phone number"
          placeholderTextColor={colors.textFaint}
          keyboardType="phone-pad"
          value={contactNumber}
          onChangeText={setContactNumber}
        />
        {fieldErrors.contact_number && (
          <Text style={styles.fieldError}>{fieldErrors.contact_number}</Text>
        )}

        <TouchableOpacity
          style={[styles.submit, !canSubmit && styles.submitDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Link Account</Text>}
        </TouchableOpacity>

        <Text style={styles.hint}>
          Not sure of your account number or the phone number on file? Please contact PG
          Networks support directly and we'll help you link your account.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingTop: 24, paddingBottom: 60 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  cancel: { color: colors.primary, fontSize: 15, fontWeight: "600" },
  intro: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 20 },
  error: { color: colors.danger, marginBottom: 16 },
  label: { color: colors.text, fontSize: 14, fontWeight: "600", marginBottom: 8, marginTop: 12 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    color: colors.text,
  },
  fieldError: { color: colors.danger, fontSize: 12, marginTop: 6 },
  submit: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 24,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  hint: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: 20, textAlign: "center" },
});
