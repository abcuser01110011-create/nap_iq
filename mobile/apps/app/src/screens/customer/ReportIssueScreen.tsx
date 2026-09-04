import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ApiError } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { colors } from "../../theme/customer";

// Kept in sync by hand with app/forms.py's ISSUE_TYPE_CHOICES on the
// backend — the mobile API validates against this exact same set
// server-side (app/routes/api_v1/customer.py's _VALID_ISSUE_TYPES),
// so a mismatch here would just surface as a 400 on submit. This is
// deliberately a narrower list than the full backend set — "Fiber/
// Cable Problem" and "NAP Problem" are left off here since they're
// hard for a subscriber to self-diagnose from the customer app; both
// remain valid choices on the staff/admin side.
const ISSUE_TYPES = ["No Internet", "Slow Internet", "Connection Problem", "Other"];

export default function ReportIssueScreen({ navigation }: any) {
  const { client } = useAuth();
  const [issueType, setIssueType] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // A photo is required to submit — same "attach before you can
  // proceed" treatment as the technician app's completion photo (see
  // JobDetailScreen). photo holds the { uri, name, type } shape
  // expo-image-picker's result gives, ready to hand straight to
  // client.customer.reportIssue.
  const [photo, setPhoto] = useState<{ uri: string; name: string; type: string } | null>(null);

  const canSubmit =
    issueType !== null && description.trim().length > 0 && photo !== null && !submitting;

  const pickPhotoFromResult = (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const extFromUri = asset.uri.split(".").pop()?.toLowerCase() || "jpg";
    const type = asset.mimeType ?? `image/${extFromUri === "jpg" ? "jpeg" : extFromUri}`;
    setPhoto({ uri: asset.uri, name: `issue-photo.${extFromUri}`, type });
    setFieldErrors((prev) => ({ ...prev, photo: "" }));
  };

  const handleTakePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Camera access needed",
        "Enable camera access for PG Networks in your device settings to take a photo of the issue."
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false });
    pickPhotoFromResult(result);
  };

  const handlePickFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Photo library access needed",
        "Enable photo library access for PG Networks in your device settings to attach a photo of the issue."
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    });
    pickPhotoFromResult(result);
  };

  const handleSubmit = async () => {
    if (!canSubmit || issueType === null || photo === null) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await client.customer.reportIssue({
        issue_type: issueType,
        description: description.trim(),
        photo,
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

        <Text style={styles.label}>Photo of the issue</Text>
        {photo ? (
          <Image source={{ uri: photo.uri }} style={styles.photoPreview} resizeMode="cover" />
        ) : (
          <Text style={styles.photoHint}>
            A photo helps our technicians diagnose the problem faster.
          </Text>
        )}
        {fieldErrors.photo && <Text style={styles.fieldError}>{fieldErrors.photo}</Text>}
        <View style={styles.photoButtonRow}>
          <TouchableOpacity style={styles.secondaryButton} onPress={handleTakePhoto}>
            <Text style={styles.secondaryButtonText}>Take photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={handlePickFromLibrary}>
            <Text style={styles.secondaryButtonText}>Choose from library</Text>
          </TouchableOpacity>
        </View>

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
  photoHint: { color: colors.textFaint, fontSize: 13, marginBottom: 4 },
  photoPreview: {
    width: "100%",
    height: 180,
    borderRadius: 12,
    marginBottom: 8,
    backgroundColor: colors.card,
  },
  photoButtonRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  secondaryButton: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryButtonText: { color: colors.text, fontSize: 13, fontWeight: "600" },
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
