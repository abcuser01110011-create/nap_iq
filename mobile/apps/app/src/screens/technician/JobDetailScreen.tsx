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
import * as FileSystem from "expo-file-system";
import { ApiError, type Assignment } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { useOffline } from "../../offline/OfflineContext";
import JobLocationMap from "../../components/JobLocationMap";
import SignaturePad from "../../components/SignaturePad";
import { colors } from "../../theme/technician";
import { JOB_TYPE_LABELS, REQUEST_TYPE_LABELS, STATUS_LABELS } from "./statusLabels";

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

  // Phase 28: the customer's sign-off, install-only — same
  // immediate-upload pattern as the completion photo above (see that
  // state's comment), just against
  // client.technician.uploadAssignmentSignature() and a different
  // response field (assignment.signature_url).
  const isInstallation = assignment.job_type === "installation";
  const [signatureUri, setSignatureUri] = useState<string | null>(null);
  const [signatureUploading, setSignatureUploading] = useState(false);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [signaturePadVisible, setSignaturePadVisible] = useState(false);

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
        "Enable camera access for PG Networks in your device settings to take a completion photo."
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
        "Enable photo library access for PG Networks in your device settings to attach a completion photo."
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

  const uploadSignature = async (uri: string, mimeType: string | undefined) => {
    if (!isOnline) {
      setSignatureError("You're offline — connect to the internet to upload a signature.");
      return;
    }
    setSignatureError(null);
    setSignatureUri(uri);
    setSignatureUploading(true);
    try {
      const extFromUri = uri.split(".").pop()?.toLowerCase() || "jpg";
      const type = mimeType ?? `image/${extFromUri === "jpg" ? "jpeg" : extFromUri}`;
      const name = `signature-${assignment.id}.${extFromUri}`;
      const result = await client.technician.uploadAssignmentSignature(assignment.id, { uri, name, type });
      // Clear the local raw-photo preview now that the upload has
      // succeeded — otherwise it would keep shadowing
      // assignment.signature_url below forever, hiding the
      // server-side scanned/cropped e-signature behind the original
      // unprocessed phone photo.
      setSignatureUri(null);
      applyAssignmentUpdate(result.assignment);
    } catch (err) {
      setSignatureUri(null);
      setSignatureError(
        err instanceof ApiError ? err.body.error ?? "Upload failed. Try again." : "Upload failed. Try again."
      );
    } finally {
      setSignatureUploading(false);
    }
  };

  const handleDrawSignature = () => {
    setSignaturePadVisible(true);
  };

  // Fires once the customer taps "Use this signature" in the pad —
  // base64 is the raw PNG (no data-URL prefix, see SignaturePad's
  // onOK handler) of what they drew on a plain white background.
  // Written out to a temp file so it can go through the exact same
  // uploadSignature(uri, mimeType) path as the old photo-based flow
  // — same endpoint, same server-side scan/cleanup, same error
  // handling — no backend or upload-plumbing changes needed for this
  // to work.
  const handleSignatureCaptured = async (base64: string) => {
    setSignaturePadVisible(false);
    const uri = `${FileSystem.cacheDirectory}signature-${assignment.id}-${Date.now()}.png`;
    try {
      await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
    } catch {
      setSignatureError("Couldn't save the signature. Please try again.");
      return;
    }
    uploadSignature(uri, "image/png");
  };

  const handlePickSignatureFromLibrary = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Photo library access needed",
        "Enable photo library access for PG Networks in your device settings to attach the customer's sign-off."
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    uploadSignature(result.assets[0].uri, result.assets[0].mimeType);
  };

  const handleComplete = () => {
    if (!assignment.photo_url) {
      setError("Add a completion photo before marking this job complete.");
      return;
    }
    if (isInstallation && !assignment.signature_url) {
      setError("Add the customer's signature before marking this installation complete.");
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
    const lat = assignment.subscriber?.latitude ?? assignment.issue?.latitude ?? assignment.service_request?.latitude;
    const lng =
      assignment.subscriber?.longitude ?? assignment.issue?.longitude ?? assignment.service_request?.longitude;
    if (lat == null || lng == null) return;
    const url = Platform.select({
      ios: `maps:0,0?q=${lat},${lng}`,
      android: `geo:0,0?q=${lat},${lng}`,
      default: `https://maps.google.com/?q=${lat},${lng}`,
    });
    Linking.openURL(url!).catch(() => {});
  };

  const lat = assignment.subscriber?.latitude ?? assignment.issue?.latitude ?? assignment.service_request?.latitude;
  const lng = assignment.subscriber?.longitude ?? assignment.issue?.longitude ?? assignment.service_request?.longitude;

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

        <Text style={styles.jobTypeLabel}>{JOB_TYPE_LABELS[assignment.job_type] ?? assignment.job_type}</Text>
        <Text style={styles.title}>
          {assignment.issue?.issue_code ??
            (assignment.service_request
              ? assignment.subscriber?.subscriber_code ??
                assignment.service_request.full_name ??
                `Installation #${assignment.service_request.id}`
              : `Job #${assignment.id}`)}
        </Text>
        <Text style={styles.subtitle}>
          {assignment.issue?.issue_type ??
            (assignment.service_request
              ? REQUEST_TYPE_LABELS[assignment.service_request.request_type] ?? assignment.service_request.request_type
              : "")}
        </Text>

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
              label={assignment.subscriber?.full_name ?? assignment.service_request?.full_name ?? assignment.issue?.issue_code ?? "Job location"}
              isOnline={isOnline}
              onOpenExternal={openMaps}
            />
          )}
          {/* A walk-in Service Order (GeoMap "+ Tickets" modal, free-text
              Customer field) has no linked Subscriber -- fall back to the
              request's own full_name/address/contact_number, which the
              backend passes through for exactly this case. */}
          <InfoRow label="Name" value={assignment.subscriber?.full_name ?? assignment.service_request?.full_name} />
          <InfoRow label="Address" value={assignment.subscriber?.address ?? assignment.issue?.address ?? assignment.service_request?.address} />
          <InfoRow label="Contact" value={assignment.subscriber?.contact_number ?? assignment.service_request?.contact_number} />
          {lat != null && lng != null && (
            <TouchableOpacity style={styles.mapLink} onPress={openMaps}>
              <Text style={styles.mapLinkText}>Open in Maps</Text>
            </TouchableOpacity>
          )}
        </View>

        {assignment.issue && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Issue</Text>
            <InfoRow label="Priority" value={assignment.issue.priority} />
            <InfoRow label="Description" value={assignment.issue.description} />
            {assignment.nap && <InfoRow label="NAP" value={`${assignment.nap.nap_code} — ${assignment.nap.name}`} />}
          </View>
        )}

        {assignment.service_request && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Installation</Text>
            <InfoRow
              label="Request type"
              value={REQUEST_TYPE_LABELS[assignment.service_request.request_type] ?? assignment.service_request.request_type}
            />
            <InfoRow label="Plan / notes" value={assignment.service_request.notes} />
            {assignment.nap && <InfoRow label="NAP" value={`${assignment.nap.nap_code} — ${assignment.nap.name}`} />}
          </View>
        )}

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

        {isInstallation && showPhotoCard && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Customer sign-off</Text>
            {signatureUri || assignment.signature_url ? (
              <Image
                source={{ uri: signatureUri ?? assignment.signature_url! }}
                style={styles.photoPreview}
                resizeMode="cover"
              />
            ) : (
              <Text style={styles.notesText}>
                {canEditNotes
                  ? "No signature added yet — required before completing this installation."
                  : "No signature was attached."}
              </Text>
            )}
            {signatureUploading && (
              <View style={styles.photoUploadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.photoUploadingText}>Uploading…</Text>
              </View>
            )}
            {signatureError && <Text style={styles.error}>{signatureError}</Text>}
            {canEditNotes && (
              <View style={styles.photoButtonRow}>
                <TouchableOpacity
                  style={styles.secondaryButtonSmall}
                  onPress={handleDrawSignature}
                  disabled={signatureUploading}
                >
                  <Text style={styles.secondaryButtonText}>Draw signature</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryButtonSmall}
                  onPress={handlePickSignatureFromLibrary}
                  disabled={signatureUploading}
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
      <SignaturePad
        visible={signaturePadVisible}
        onCancel={() => setSignaturePadVisible(false)}
        onSave={handleSignatureCaptured}
      />
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
  jobTypeLabel: {
    color: colors.textFaint,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 16,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "800", marginTop: 2 },
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