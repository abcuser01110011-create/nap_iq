import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ApiError, type Assignment } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { useOffline } from "../../offline/OfflineContext";
import JobLocationMap from "../../components/JobLocationMap";
import { colors } from "../../theme/technician";
import { STATUS_LABELS } from "./statusLabels";

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

export default function JobDetailScreen({ route, navigation }: any) {
  const initial: Assignment = route.params.assignment;
  const { client } = useAuth();
  const {
    getAssignment,
    acceptJob,
    startJob,
    saveNotes,
    completeJob,
    applyAssignmentUpdate,
    pendingByAssignment,
    conflicts,
    dismissConflict,
    isOnline,
  } = useOffline();

  // getAssignment() reflects the latest cached state, including any
  // optimistic update from a queued-but-not-yet-synced action — falls
  // back to the object passed in via route params (e.g. a job that
  // isn't in either cached list yet, which shouldn't normally happen
  // but keeps this screen from ever rendering blank).
  const assignment = getAssignment(initial.id) ?? initial;
  const [notes, setNotes] = useState(assignment.resolution_notes ?? "");
  const [error, setError] = useState<string | null>(null);

  // The completion photo is uploaded immediately on pick (it isn't
  // queued through the offline pending-actions system like
  // accept/start/notes/complete are — see applyAssignmentUpdate's
  // comment in OfflineContext for why). photoUri holds a local
  // preview the moment something's picked, before the network call
  // resolves; assignment.photo_url (from the server, via
  // applyAssignmentUpdate) is the source of truth once it lands.
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const pendingCount = pendingByAssignment[assignment.id] ?? 0;
  const conflict = conflicts[assignment.id];

  // Keep the notes field synced if a queued action elsewhere updates
  // the cached resolution_notes (e.g. this same job open on another
  // path) without clobbering what the tech is actively typing.
  useEffect(() => {
    if (!notes) setNotes(assignment.resolution_notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.resolution_notes]);

  const handleAccept = () => {
    setError(null);
    acceptJob(assignment.id);
  };

  const handleStart = () => {
    setError(null);
    startJob(assignment.id);
  };

  const handleSaveNotes = () => {
    if (!notes.trim()) {
      setError("Enter some notes before saving.");
      return;
    }
    setError(null);
    saveNotes(assignment.id, notes.trim());
  };

  const uploadPhoto = async (uri: string, mimeType: string | undefined) => {
    if (!isOnline) {
      setPhotoError("You're offline — connect to the internet to upload a photo.");
      return;
    }
    setPhotoError(null);
    setPhotoUri(uri);
    setPhotoUploading(true);
    try {
      const extFromUri = uri.split(".").pop()?.toLowerCase() || "jpg";
      const type = mimeType ?? `image/${extFromUri === "jpg" ? "jpeg" : extFromUri}`;
      const name = `completion-${assignment.id}.${extFromUri}`;
      const result = await client.technician.uploadAssignmentPhoto(assignment.id, { uri, name, type });
      applyAssignmentUpdate(result.assignment);
    } catch (err) {
      setPhotoUri(null);
      setPhotoError(err instanceof ApiError ? err.body.error ?? "Upload failed. Try again." : "Upload failed. Try again.");
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleTakePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Camera access needed",
        "Enable camera access for NAP-IQ in your device settings to take a completion photo."
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false });
    if (result.canceled || !result.assets?.[0]) return;
    uploadPhoto(result.assets[0].uri, result.assets[0].mimeType);
  };

  const handlePickFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Photo library access needed",
        "Enable photo library access for NAP-IQ in your device settings to attach a completion photo."
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    uploadPhoto(result.assets[0].uri, result.assets[0].mimeType);
  };

  const handleComplete = () => {
    if (!assignment.photo_url) {
      setError("Add a completion photo before marking this job complete.");
      return;
    }
    if (!notes.trim() && !assignment.resolution_notes) {
      setError("Resolution notes are required to complete a job.");
      return;
    }
    Alert.alert("Complete this job?", "This marks the issue resolved and can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Complete",
        style: "default",
        onPress: () => {
          setError(null);
          completeJob(assignment.id, notes.trim() || undefined);
          navigation.goBack();
        },
      },
    ]);
  };

  const openMaps = () => {
    const lat = assignment.subscriber?.latitude ?? assignment.issue?.latitude;
    const lng = assignment.subscriber?.longitude ?? assignment.issue?.longitude;
    if (lat == null || lng == null) return;
    const url = Platform.select({
      ios: `maps:0,0?q=${lat},${lng}`,
      android: `geo:0,0?q=${lat},${lng}`,
      default: `https://maps.google.com/?q=${lat},${lng}`,
    });
    Linking.openURL(url!).catch(() => {});
  };

  const lat = assignment.subscriber?.latitude ?? assignment.issue?.latitude;
  const lng = assignment.subscriber?.longitude ?? assignment.issue?.longitude;

  const canAccept = assignment.status === "assigned";
  const canStart = assignment.status === "accepted";
  const canEditNotes = assignment.status === "accepted" || assignment.status === "in_progress";
  const canComplete = assignment.status === "in_progress";
  const isClosed = assignment.status === "completed" || assignment.status === "cancelled";
  const showPhotoCard = canEditNotes || isClosed || Boolean(assignment.photo_url);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.back}>‹ Back</Text>
          </TouchableOpacity>
          <View style={styles.statusBadge}>
            <Text style={styles.statusBadgeText}>
              {STATUS_LABELS[assignment.status] ?? assignment.status}
            </Text>
          </View>
        </View>

        <Text style={styles.title}>{assignment.issue?.issue_code ?? `Job #${assignment.id}`}</Text>
        <Text style={styles.subtitle}>{assignment.issue?.issue_type}</Text>

        {!isOnline && pendingCount > 0 && (
          <View style={styles.queuedBanner}>
            <Text style={styles.queuedBannerText}>
              {pendingCount} change{pendingCount === 1 ? "" : "s"} queued — will sync once you're
              back online.
            </Text>
          </View>
        )}
        {isOnline && pendingCount > 0 && (
          <View style={styles.queuedBanner}>
            <Text style={styles.queuedBannerText}>Syncing your last update…</Text>
          </View>
        )}
        {conflict && (
          <View style={styles.conflictBanner}>
            <Text style={styles.conflictBannerText}>{conflict}</Text>
            <TouchableOpacity onPress={() => dismissConflict(assignment.id)}>
              <Text style={styles.conflictDismiss}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        )}
        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Subscriber</Text>
          {lat != null && lng != null && (
            <JobLocationMap
              latitude={lat}
              longitude={lng}
              label={assignment.subscriber?.full_name ?? assignment.issue?.issue_code ?? "Job location"}
              isOnline={isOnline}
              onOpenExternal={openMaps}
            />
          )}
          <InfoRow label="Name" value={assignment.subscriber?.full_name} />
          <InfoRow label="Address" value={assignment.subscriber?.address ?? assignment.issue?.address} />
          <InfoRow label="Contact" value={assignment.subscriber?.contact_number} />
          {lat != null && lng != null && (
            <TouchableOpacity style={styles.mapLink} onPress={openMaps}>
              <Text style={styles.mapLinkText}>Open in Maps</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Issue</Text>
          <InfoRow label="Priority" value={assignment.issue?.priority} />
          <InfoRow label="Description" value={assignment.issue?.description} />
          {assignment.nap && <InfoRow label="NAP" value={`${assignment.nap.nap_code} — ${assignment.nap.name}`} />}
        </View>

        {(canEditNotes || isClosed) && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Resolution notes</Text>
            {canEditNotes ? (
              <>
                <TextInput
                  style={styles.textArea}
                  placeholder="What did you find, and what did you do?"
                  placeholderTextColor={colors.textFaint}
                  multiline
                  numberOfLines={4}
                  value={notes}
                  onChangeText={setNotes}
                />
                <TouchableOpacity style={styles.secondaryButton} onPress={handleSaveNotes}>
                  <Text style={styles.secondaryButtonText}>Save notes</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.notesText}>
                {assignment.resolution_notes || "No notes recorded."}
              </Text>
            )}
          </View>
        )}

        {showPhotoCard && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Completion photo</Text>
            {photoUri || assignment.photo_url ? (
              <Image
                source={{ uri: photoUri ?? assignment.photo_url! }}
                style={styles.photoPreview}
                resizeMode="cover"
              />
            ) : (
              <Text style={styles.notesText}>
                {canEditNotes
                  ? "No photo added yet — required before completing this job."
                  : "No photo was attached."}
              </Text>
            )}
            {photoUploading && (
              <View style={styles.photoUploadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.photoUploadingText}>Uploading…</Text>
              </View>
            )}
            {photoError && <Text style={styles.error}>{photoError}</Text>}
            {canEditNotes && (
              <View style={styles.photoButtonRow}>
                <TouchableOpacity
                  style={styles.secondaryButtonSmall}
                  onPress={handleTakePhoto}
                  disabled={photoUploading}
                >
                  <Text style={styles.secondaryButtonText}>Take photo</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryButtonSmall}
                  onPress={handlePickFromLibrary}
                  disabled={photoUploading}
                >
                  <Text style={styles.secondaryButtonText}>Choose from library</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        <View style={styles.actions}>
          {canAccept && (
            <TouchableOpacity style={styles.primaryButton} onPress={handleAccept}>
              <Text style={styles.primaryButtonText}>Accept job</Text>
            </TouchableOpacity>
          )}
          {canStart && (
            <TouchableOpacity style={styles.primaryButton} onPress={handleStart}>
              <Text style={styles.primaryButtonText}>Start job</Text>
            </TouchableOpacity>
          )}
          {canComplete && (
            <TouchableOpacity
              style={[styles.primaryButton, styles.completeButton]}
              onPress={handleComplete}
            >
              <Text style={styles.primaryButtonText}>Mark complete</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingTop: 56, paddingBottom: 60 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  back: { color: colors.primary, fontSize: 15, fontWeight: "600" },
  statusBadge: {
    backgroundColor: colors.primaryLight,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  statusBadgeText: { color: "#8FB6FF", fontSize: 12, fontWeight: "700" },
  title: { color: colors.text, fontSize: 22, fontWeight: "800", marginTop: 16 },
  subtitle: { color: colors.textFaint, fontSize: 14, marginTop: 2, marginBottom: 16 },
  error: { color: colors.danger, marginBottom: 12 },
  queuedBanner: {
    backgroundColor: colors.primaryLight,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  queuedBannerText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  conflictBanner: {
    backgroundColor: colors.dangerLight,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  conflictBannerText: { color: colors.danger, fontSize: 13, fontWeight: "600" },
  conflictDismiss: { color: colors.danger, fontSize: 12, fontWeight: "700", marginTop: 8 },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, marginBottom: 14 },
  cardLabel: {
    color: colors.textFaint,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  infoRow: { marginBottom: 8 },
  infoLabel: { color: colors.textFaint, fontSize: 12 },
  infoValue: { color: colors.text, fontSize: 14, fontWeight: "600", marginTop: 2 },
  mapLink: { marginTop: 4 },
  mapLinkText: { color: colors.primary, fontSize: 14, fontWeight: "600" },
  textArea: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    color: colors.text,
    minHeight: 90,
    textAlignVertical: "top",
    marginBottom: 10,
  },
  notesText: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryButtonText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
  photoPreview: {
    width: "100%",
    height: 180,
    borderRadius: 10,
    backgroundColor: colors.bg,
    marginBottom: 10,
  },
  photoButtonRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  secondaryButtonSmall: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  photoUploadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  photoUploadingText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  actions: { marginTop: 8, gap: 12 },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  completeButton: { backgroundColor: colors.success },
  primaryButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});