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
import { ApiError, type ReportIssueInput } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";

// Kept in sync by hand with app/forms.py's ISSUE_TYPE_CHOICES on the
// backend — the mobile API validates against this exact same set
// server-side (app/routes/api_v1/customer.py's _VALID_ISSUE_TYPES),
// so a mismatch here would just surface as a 400 on submit.
const ISSUE_TYPES = [
  "No Internet",
  "Slow Internet",
  "Fiber/Cable Problem",
  "NAP Problem",
  "Connection Problem",
  "Other",
];

// Labels mirror the GeoMap's PRIORITY_LABELS (app/static/js/napmap.js)
// and the field assistant's technician/statusLabels.ts, where
// "critical" reads "Urgent" everywhere it's shown to a person -- the
// underlying value sent to the API stays "critical".
const PRIORITIES: Array<{ value: NonNullable<ReportIssueInput["priority"]>; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Urgent" },
];

export default function ReportIssueScreen({ navigation }: any) {
  const { client } = useAuth();
  const [issueType, setIssueType] = useState<string | null>(null);
  const [priority, setPriority] = useState<NonNullable<ReportIssueInput["priority"]>>("medium");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const canSubmit = issueType !== null && description.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || issueType === null) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await client.customer.reportIssue({
        issue_type: issueType,
        priority,
        description: description.trim(),
      });
      navigation.goBack();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.body.errors) {
          setFieldErrors(err.body.errors);
        } else {
          setError(err.body.error ?? "Couldn't submit your issue. Please try again.");
        }
      } else {
        setError("Couldn't reach the server. Check your connection.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Report an issue</Text>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.cancel}>Cancel</Text>
          </TouchableOpacity>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <Text style={styles.label}>What's wrong?</Text>
        <View style={styles.chipRow}>
          {ISSUE_TYPES.map((type) => (
            <TouchableOpacity
              key={type}
              style={[styles.chip, issueType === type && styles.chipSelected]}
              onPress={() => setIssueType(type)}
            >
              <Text style={[styles.chipText, issueType === type && styles.chipTextSelected]}>
                {type}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {fieldErrors.issue_type && <Text style={styles.fieldError}>{fieldErrors.issue_type}</Text>}

        <Text style={styles.label}>Priority</Text>
        <View style={styles.chipRow}>
          {PRIORITIES.map((p) => (
            <TouchableOpacity
              key={p.value}
              style={[styles.chip, priority === p.value && styles.chipSelected]}
              onPress={() => setPriority(p.value)}
            >
              <Text style={[styles.chipText, priority === p.value && styles.chipTextSelected]}>
                {p.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {fieldErrors.priority && <Text style={styles.fieldError}>{fieldErrors.priority}</Text>}

        <Text style={styles.label}>Describe the issue</Text>
        <TextInput
          style={styles.textArea}
          placeholder="What's happening, and since when?"
          placeholderTextColor={colors.textFaint}
          multiline
          numberOfLines={5}
          maxLength={2000}
          value={description}
          onChangeText={setDescription}
        />
        {fieldErrors.description && (
          <Text style={styles.fieldError}>{fieldErrors.description}</Text>
        )}

        <TouchableOpacity
          style={[styles.submit, !canSubmit && styles.submitDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitText}>Submit</Text>
          )}
        </TouchableOpacity>
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
    marginBottom: 20,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  cancel: { color: colors.primary, fontSize: 15, fontWeight: "600" },
  error: { color: colors.danger, marginBottom: 16 },
  label: { color: colors.text, fontSize: 14, fontWeight: "600", marginBottom: 8, marginTop: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  chipTextSelected: { color: "#FFFFFF" },
  fieldError: { color: colors.danger, fontSize: 12, marginTop: 6 },
  textArea: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    color: colors.text,
    minHeight: 120,
    textAlignVertical: "top",
  },
  submit: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 24,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
