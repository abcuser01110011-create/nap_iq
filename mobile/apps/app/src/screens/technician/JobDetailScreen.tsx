import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { ApiError, type Assignment } from "@nap-iq/api-client";
import { useAuth } from "../../auth/AuthContext";
import { useOffline } from "../../offline/OfflineContext";
import JobLocationMap from "../../components/JobLocationMap";
import { colors } from "../../theme/technician";
import { JOB_TYPE_LABELS, REQUEST_TYPE_LABELS, STATUS_LABELS, ticketCode } from "./statusLabels";

// How long we'll wait for a GPS fix before treating it as a timeout —
// same value/reasoning as the customer app's "Track My Location" step
// on ApplyForServiceScreen: expo-location's getCurrentPositionAsync
// has no built-in timeout, so this is enforced by racing it against a
// plain setTimeout below.
const LOCATION_FIX_TIMEOUT_MS = 20000;

// Company's home service area — same default the admin's Barangay
// picker falls back to (see app/static/js/tickets.js). Used so a
// ticket with no address on file still shows something sensible
// instead of a blank row.
const DEFAULT_ADDRESS = "Sta. Cruz, Laguna";

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
  // Resolution notes are optional — the field is still here for the
  // technician to jot down what they found/did, but nothing requires
  // it before a job can be completed, and there's no separate "Save
  // notes" step; whatever's typed here is sent along automatically
  // when the job is marked complete (see handleComplete below).
  const [notes, setNotes] = useState(assignment.resolution_notes ?? "");
  const [error, setError] = useState<string | null>(null);

  // The NAP port the technician serviced — same "no separate save
  // step, sent along automatically on complete" treatment as notes
  // above. Only shown/settable when the job has a linked NAP, since
  // that's what supplies the 1..total_ports range (see
  // _validate_port_number() in api_v1/technician.py).
  const [portNumber, setPortNumber] = useState<number | null>(assignment.port_number ?? null);
  const [portModalVisible, setPortModalVisible] = useState(false);

  // The completion photo is uploaded immediately on pick (it isn't
  // queued through the offline pending-actions system like
  // accept/start/complete are — see applyAssignmentUpdate's comment
  // in OfflineContext for why). photoUri holds a local preview the
  // moment something's picked, before the network call resolves;
  // assignment.photo_url (from the server, via applyAssignmentUpdate)
  // is the source of truth once it lands.
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Pin location — install-only, replaces the old customer-signature
  // step. Same "Track My Location" pattern the customer app uses on
  // ApplyForServiceScreen: a real device GPS fix, submitted straight
  // to the server as soon as it's captured (not queued offline, same
  // reasoning as the photo above — a stale queued fix would be
  // actively misleading here).
  const isInstallation = assignment.job_type === "installation";
  const [pinCapturing, setPinCapturing] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const pendingCount = pendingByAssignment[assignment.id] ?? 0;
  const conflict = conflicts[assignment.id];

  // Keep the notes field synced if a queued action elsewhere updates
  // the cached resolution_notes (e.g. this same job open on another
  // path) without clobbering what the tech is actively typing.
  useEffect(() => {
    if (!notes) setNotes(assignment.resolution_notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.resolution_notes]);

  // Same pattern as notes above, for the port dropdown.
  useEffect(() => {
    if (portNumber == null) setPortNumber(assignment.port_number ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.port_number]);

  const handleAccept = () => {
    setError(null);
    acceptJob(assignment.id);
  };

  const handleStart = () => {
    setError(null);
    startJob(assignment.id);
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

  const getFixWithTimeout = (options: Location.LocationOptions, timeoutMs: number) => {
    return Promise.race([
      Location.getCurrentPositionAsync(options),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
      }),
    ]);
  };

  // Fires when the technician taps "Pin My Location" / "Update My
  // Location" on an installation job. Same request pattern as the
  // customer app's "Track My Location" step (services-enabled check,
  // then permission, then a timed fix) but posted straight to the
  // server as soon as it lands, rather than staying purely local —
  // this is what actually satisfies the pin-location requirement
  // client.technician.pinAssignmentLocation() (see
  // pin_assignment_location() in api_v1/technician.py).
  const handlePinLocation = async () => {
    if (!isOnline) {
      setPinError("You're offline — connect to the internet to pin your location.");
      return;
    }
    setPinError(null);
    setPinCapturing(true);
    try {
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        setPinError("Location services are turned off on this device. Enable them in Settings, then try again.");
        return;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setPinError("Location permission was denied. Allow location access for PG Networks in your device settings, then try again.");
        return;
      }

      const position = await getFixWithTimeout({ accuracy: Location.Accuracy.High }, LOCATION_FIX_TIMEOUT_MS);
      const { latitude, longitude } = position.coords;

      const result = await client.technician.pinAssignmentLocation(assignment.id, latitude, longitude);
      applyAssignmentUpdate(result.assignment);
    } catch (err: any) {
      if (err?.message === "TIMEOUT") {
        setPinError("Timed out waiting for a location fix. Try again, ideally outdoors with a clear view of the sky.");
      } else if (err instanceof ApiError) {
        setPinError(err.body.error ?? "Couldn't save your location. Try again.");
      } else {
        setPinError("Could not get your location. Please try again.");
      }
    } finally {
      setPinCapturing(false);
    }
  };

  const handleComplete = () => {
    if (!assignment.photo_url) {
      setError("Add a completion photo before marking this job complete.");
      return;
    }
    if (isInstallation && (assignment.pin_latitude == null || assignment.pin_longitude == null)) {
      setError("Pin your location before marking this installation complete.");
      return;
    }
    Alert.alert("Complete this job?", "This marks the issue resolved and can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Complete",
        style: "default",
        onPress: () => {
          setError(null);
          completeJob(assignment.id, notes.trim() || undefined, portNumber);
          navigation.goBack();
        },
      },
    ]);
  };

  // A Fiber Break job is dispatched against the NAP, not any one
  // subscriber's home (see report_fiber_break() in
  // app/routes/issues.py — every connected subscriber gets their own
  // shadow ticket so their account/marker reflects the outage, but
  // only the NAP itself is where a field assistant actually needs to
  // go). The backend already points the *dispatched* issue's own
  // latitude/longitude at the NAP for exactly this reason, but
  // `assignment.subscriber` is always that ticket's linked
  // subscriber's own home coordinates regardless of issue type — so
  // for a Fiber Break specifically, the NAP's coordinates (falling
  // back to the issue's, which mirror the NAP once dispatched) must
  // be preferred over the subscriber's. Every other job type (a
  // single subscriber's own repair, or an installation) keeps the
  // original subscriber-first priority, since those really are about
  // that one address.
  const isFiberBreak = assignment.issue?.issue_type === "Fiber Break";
  const lat = isFiberBreak
    ? assignment.nap?.latitude ?? assignment.issue?.latitude ?? assignment.subscriber?.latitude ?? assignment.service_request?.latitude
    : assignment.subscriber?.latitude ?? assignment.issue?.latitude ?? assignment.service_request?.latitude;
  const lng = isFiberBreak
    ? assignment.nap?.longitude ?? assignment.issue?.longitude ?? assignment.subscriber?.longitude ?? assignment.service_request?.longitude
    : assignment.subscriber?.longitude ?? assignment.issue?.longitude ?? assignment.service_request?.longitude;

  const openMaps = () => {
    if (lat == null || lng == null) return;
    const url = Platform.select({
      ios: `maps:0,0?q=${lat},${lng}`,
      android: `geo:0,0?q=${lat},${lng}`,
      default: `https://maps.google.com/?q=${lat},${lng}`,
    });
    Linking.openURL(url!).catch(() => {});
  };

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

        {/* Ticket Details — mirrors the admin's ticket view (issues/view.html
            / service_requests/form.html): ticket identity, priority/status,
            requester info, and description/notes all in one place, so the
            field assistant sees the same information an admin filled in
            before deciding to accept. No map here — see "Live tracking"
            below, which only appears once the job is accepted. */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Ticket Details</Text>
          <InfoRow label="Ticket ID" value={ticketCode(assignment)} />
          <InfoRow
            label="Type"
            value={
              assignment.issue?.issue_type ??
              (assignment.service_request
                ? REQUEST_TYPE_LABELS[assignment.service_request.request_type] ?? assignment.service_request.request_type
                : undefined)
            }
          />
          <InfoRow label="Priority" value={assignment.issue?.priority ?? assignment.service_request?.priority} />
          <InfoRow label="Status" value={STATUS_LABELS[assignment.status] ?? assignment.status} />
          {/* A walk-in Service Order (GeoMap "+ Tickets" modal, free-text
              Customer field) has no linked Subscriber -- fall back to the
              request's own full_name/address/contact_number, which the
              backend passes through for exactly this case. "Add NAP"
              repurposes that same field for a planned NAP's name, so it
              gets its own label ("NAP" instead of "Subscriber") — but the
              name itself is shown exactly as entered, free-text, with no
              default label or suffix appended. */}
          <InfoRow
            label={assignment.service_request?.request_type === "add_nap" ? "NAP" : "Subscriber"}
            value={
              assignment.subscriber
                ? `${assignment.subscriber.subscriber_code} — ${assignment.subscriber.full_name}`
                : assignment.service_request?.full_name
            }
          />
          <InfoRow
            label="Address"
            value={
              assignment.subscriber?.address ??
              assignment.issue?.address ??
              assignment.service_request?.address ??
              DEFAULT_ADDRESS
            }
          />
          <InfoRow label="Contact" value={assignment.subscriber?.contact_number ?? assignment.service_request?.contact_number} />
          {lat != null && lng != null && <InfoRow label="Coordinates" value={`${lat.toFixed(6)}, ${lng.toFixed(6)}`} />}
          {assignment.issue && <InfoRow label="Description" value={assignment.issue.description} />}
          {assignment.service_request && <InfoRow label="Plan / notes" value={assignment.service_request.notes} />}
          {assignment.nap && <InfoRow label="NAP" value={`${assignment.nap.nap_code} — ${assignment.nap.name}`} />}
          {lat != null && lng != null && (
            <TouchableOpacity style={styles.mapLink} onPress={openMaps}>
              <Text style={styles.mapLinkText}>Open in Maps</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Location — only shown once the technician has accepted the job
            (status moves past "assigned"). Before that, the field
            assistant only sees the ticket form above and the Accept
            button below. Tapping the preview opens the device's Google
            Maps (or Apple Maps on iOS) app for actual turn-by-turn
            navigation, same as the "Open in Maps" link above. */}
        {lat != null && lng != null && assignment.status !== "assigned" && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Location</Text>
            <JobLocationMap
              latitude={lat}
              longitude={lng}
              label={
                assignment.subscriber?.full_name ?? assignment.service_request?.full_name ?? assignment.issue?.issue_code ?? "Job location"
              }
              isOnline={isOnline}
              onOpenExternal={openMaps}
            />
          </View>
        )}

        {(canEditNotes || isClosed) && assignment.nap && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Port number</Text>
            {canEditNotes ? (
              <TouchableOpacity
                style={styles.dropdownField}
                onPress={() => setPortModalVisible(true)}
                activeOpacity={0.7}
              >
                <Text style={portNumber != null ? styles.dropdownValue : styles.dropdownPlaceholder}>
                  {portNumber != null ? `Port ${portNumber}` : "Select a port (optional)"}
                </Text>
                <Text style={styles.dropdownChevron}>{"\u25BE"}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.notesText}>
                {portNumber != null ? `Port ${portNumber}` : "No port recorded."}
              </Text>
            )}
          </View>
        )}

        <Modal
          visible={portModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setPortModalVisible(false)}
        >
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setPortModalVisible(false)}
          >
            <View style={styles.portModalCard}>
              <Text style={styles.modalTitle}>Select a port</Text>
              <ScrollView style={styles.portList}>
                {assignment.nap &&
                  Array.from({ length: assignment.nap.total_ports }, (_, i) => i + 1).map((n) => (
                    <TouchableOpacity
                      key={n}
                      style={styles.portOption}
                      onPress={() => {
                        setPortNumber(n);
                        setPortModalVisible(false);
                      }}
                    >
                      <Text style={n === portNumber ? styles.portOptionTextSelected : styles.portOptionText}>
                        Port {n}
                      </Text>
                    </TouchableOpacity>
                  ))}
              </ScrollView>
              <TouchableOpacity
                style={styles.portClearRow}
                onPress={() => {
                  setPortNumber(null);
                  setPortModalVisible(false);
                }}
              >
                <Text style={styles.portClearText}>Clear selection</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        {(canEditNotes || isClosed) && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Resolution notes</Text>
            {canEditNotes ? (
              <TextInput
                style={styles.textArea}
                placeholder="What did you find, and what did you do? (optional)"
                placeholderTextColor={colors.textFaint}
                multiline
                numberOfLines={4}
                value={notes}
                onChangeText={setNotes}
              />
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
            <Text style={styles.cardLabel}>Pin location</Text>
            {assignment.pin_latitude != null && assignment.pin_longitude != null ? (
              <JobLocationMap
                latitude={assignment.pin_latitude}
                longitude={assignment.pin_longitude}
                label="Pinned location"
                isOnline={isOnline}
                onOpenExternal={() => {
                  const url = Platform.select({
                    ios: `maps:0,0?q=${assignment.pin_latitude},${assignment.pin_longitude}`,
                    android: `geo:0,0?q=${assignment.pin_latitude},${assignment.pin_longitude}`,
                    default: `https://maps.google.com/?q=${assignment.pin_latitude},${assignment.pin_longitude}`,
                  });
                  Linking.openURL(url!).catch(() => {});
                }}
              />
            ) : (
              <Text style={styles.notesText}>
                {canEditNotes
                  ? "No location pinned yet — required before completing this installation."
                  : "No location was pinned."}
              </Text>
            )}
            {pinCapturing && (
              <View style={styles.photoUploadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.photoUploadingText}>Getting your location…</Text>
              </View>
            )}
            {pinError && <Text style={styles.error}>{pinError}</Text>}
            {canEditNotes && (
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={handlePinLocation}
                disabled={pinCapturing}
              >
                <Text style={styles.secondaryButtonText}>
                  {assignment.pin_latitude != null ? "Update My Location" : "Pin My Location"}
                </Text>
              </TouchableOpacity>
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
  dropdownField: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  dropdownValue: { color: colors.text, fontSize: 14, fontWeight: "600" },
  dropdownPlaceholder: { color: colors.textFaint, fontSize: 14 },
  dropdownChevron: { color: colors.textFaint, fontSize: 14 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  portModalCard: {
    width: "100%",
    maxHeight: "70%",
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: "700", marginBottom: 10 },
  portList: { marginBottom: 8 },
  portOption: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  portOptionText: { color: colors.textMuted, fontSize: 15 },
  portOptionTextSelected: { color: colors.primary, fontSize: 15, fontWeight: "700" },
  portClearRow: { paddingVertical: 12, alignItems: "center" },
  portClearText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
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