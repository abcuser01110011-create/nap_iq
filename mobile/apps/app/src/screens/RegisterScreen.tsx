import React, { useState, useRef } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import * as Location from "expo-location";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth } from "../auth/AuthContext";
import { colors } from "../theme/shared";
import type { AuthStackParamList } from "../navigation/RootNavigator";

type LatLng = { latitude: number; longitude: number };

type Props = NativeStackScreenProps<AuthStackParamList, "Register">;

type Step = "location" | "plan" | "details";

type GeoState = "idle" | "requesting" | "error";

// Manila as a reasonable default map center before any real fix has
// come in. Never submitted as-is — the map starts pin-less; a pin can
// only ever appear once a real device GPS fix lands (see
// window.napiqSetFix below), never from a tap or drag.
const DEFAULT_CENTER: LatLng = { latitude: 14.5995, longitude: 120.9842 };

// How long we'll wait for a fix before treating it as a timeout.
// expo-location's getCurrentPositionAsync has no built-in timeout, so
// this is enforced by racing it against a plain setTimeout below.
const LOCATION_FIX_TIMEOUT_MS = 20000;

// Builds the HTML page that runs inside the WebView. Uses Leaflet.js
// pulling free OpenStreetMap tiles — no Google Maps SDK, no API key,
// no billing account required.
//
// This map is display-only. There is deliberately no click or drag
// handler here — the only way a pin can ever land on it is a real
// device GPS fix pushed in from React Native via window.napiqSetFix(),
// never a manual tap or drag. That's what actually prevents an
// applicant from pinning a random location: it's not that the app
// asks nicely, it's that there is no code path left that accepts a
// hand-placed coordinate.
function buildMapHtml(center: LatLng) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <style>
        html, body, #map { height: 100%; margin: 0; padding: 0; }
      </style>
    </head>
    <body>
      <div id="map"></div>
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        const map = L.map('map', { zoomControl: true }).setView(
          [${center.latitude}, ${center.longitude}],
          12
        );
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        let marker = null;
        let accuracyCircle = null;

        // Called from React Native (via injectJavaScript) with a real
        // GPS fix. Places a fixed (non-draggable) marker, draws an
        // accuracy ring, and flies the map in tight on that exact
        // point so the applicant can see precisely where they were
        // detected, not just a marker somewhere on a still-zoomed-out
        // map.
        window.napiqSetFix = function (lat, lng, accuracy) {
          if (marker) {
            marker.setLatLng([lat, lng]);
          } else {
            marker = L.marker([lat, lng]).addTo(map);
          }

          if (accuracyCircle) {
            map.removeLayer(accuracyCircle);
            accuracyCircle = null;
          }
          if (accuracy && accuracy > 0) {
            accuracyCircle = L.circle([lat, lng], {
              radius: accuracy,
              color: '#2E7DFF',
              fillColor: '#2E7DFF',
              fillOpacity: 0.12,
              weight: 1
            }).addTo(map);
          }

          map.flyTo([lat, lng], 17, { animate: true, duration: 0.75 });
        };
      </script>
    </body>
    </html>
  `;
}

export default function RegisterScreen({ navigation }: Props) {
  const { register, lastError } = useAuth();

  const [step, setStep] = useState<Step>("location");
  const [pin, setPin] = useState<LatLng | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [coverageResult, setCoverageResult] = useState<{ available: boolean; distanceKm?: number } | null>(null);

  // Device-GPS acquisition state — separate from `checking` (the
  // coverage-check network call) since these are two different
  // "please wait" moments the user needs to be able to tell apart.
  const [geoState, setGeoState] = useState<GeoState>("idle");
  const [geoError, setGeoError] = useState<string | null>(null);

  // Consent gate: the permission popup (native OS dialog, triggered by
  // requestForegroundPermissionsAsync below) only ever fires after the
  // applicant has explicitly agreed here, once per app session.
  const [consentVisible, setConsentVisible] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentAgreed, setConsentAgreed] = useState(false);

  const [plans, setPlans] = useState<string[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);

  const [address, setAddress] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const webviewRef = useRef<WebView>(null);

  // Same client instance AuthContext already built, reached through
  // useAuth so this screen doesn't construct a second one.
  const { client } = useAuth();

  const focusMapOnFix = (lat: number, lng: number, acc: number | null) => {
    webviewRef.current?.injectJavaScript(
      `window.napiqSetFix && window.napiqSetFix(${lat}, ${lng}, ${acc ?? 0}); true;`
    );
  };

  const getFixWithTimeout = (options: Location.LocationOptions, timeoutMs: number) => {
    return Promise.race([
      Location.getCurrentPositionAsync(options),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
      }),
    ]);
  };

  const requestLocation = async () => {
    setGeoError(null);
    setGeoState("requesting");
    try {
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        setGeoState("error");
        setGeoError("Location services are turned off on this device. Enable them in Settings, then try again.");
        return;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setGeoState("error");
        setGeoError("Location permission was denied. Allow location access for NAP-IQ in your device settings, then try again.");
        return;
      }

      const position = await getFixWithTimeout(
        { accuracy: Location.Accuracy.High },
        LOCATION_FIX_TIMEOUT_MS
      );
      const { latitude, longitude, accuracy: acc } = position.coords;

      setPin({ latitude, longitude });
      setAccuracy(acc ?? null);
      setCoverageResult(null);
      setGeoState("idle");
      focusMapOnFix(latitude, longitude, acc ?? null);
    } catch (err: any) {
      setGeoState("error");
      if (err?.message === "TIMEOUT") {
        setGeoError("Timed out waiting for a location fix. Try again, ideally outdoors with a clear view of the sky.");
      } else {
        setGeoError("Could not get your location. Please try again.");
      }
    }
  };

  const handleTrackLocationPress = () => {
    if (consentChecked) {
      requestLocation();
      return;
    }
    setConsentAgreed(false);
    setConsentVisible(true);
  };

  const handleConsentConfirm = () => {
    setConsentVisible(false);
    setConsentChecked(true);
    requestLocation();
  };

  const handleCheckCoverage = async () => {
    if (!pin) return;
    setLocalError(null);
    setChecking(true);
    setCoverageResult(null);
    try {
      const result = await client.public.checkCoverage(pin.latitude, pin.longitude);
      setCoverageResult({ available: result.available, distanceKm: result.distance_km });
      if (result.available) {
        const plansResult = await client.public.listPlans();
        setPlans(plansResult.plans);
      }
    } catch {
      setLocalError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setChecking(false);
    }
  };

  const handleSubmit = async () => {
    setLocalError(null);
    if (password !== confirmPassword) {
      setLocalError("Passwords do not match.");
      return;
    }
    if (!pin) {
      setLocalError("Please set your installation location first.");
      return;
    }
    setSubmitting(true);
    try {
      await register({
        username: username.trim(),
        password,
        full_name: fullName.trim(),
        email: email.trim() || undefined,
        phone_number: phone.trim() || undefined,
        latitude: pin.latitude,
        longitude: pin.longitude,
        address: address.trim() || undefined,
        plan_name: selectedPlan ?? undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {step === "location" ? (
        // Step 1 deliberately isn't inside a ScrollView: there are no
        // text inputs here, so nothing needs keyboard-driven scrolling,
        // and giving the map a flex:1 wrapper lets it expand to fill
        // whatever vertical space the title/hint/buttons/link don't
        // need, instead of sitting at a small fixed height with a big
        // blank gap under the "Sign in" link.
        <View style={styles.locationStepContainer}>
          <Text style={styles.title}>Apply for service</Text>
          <Text style={styles.subtitle}>Step 1 of 3 — Track your installation address</Text>

          <View style={styles.mapWrap}>
            <WebView
              ref={webviewRef}
              originWhitelist={["*"]}
              source={{ html: buildMapHtml(DEFAULT_CENTER) }}
              style={styles.map}
            />
          </View>

          <Text style={styles.hint}>
            {pin
              ? "Location captured from your device" + (accuracy != null ? ` (±${Math.round(accuracy)}m accuracy)` : "") + ". Tap Track My Location again to refresh it."
              : "Tap \"Track My Location\" to verify your installation address using your device's real location. Manual pin placement isn't available, so the address on file always reflects where the applicant actually is."}
          </Text>

          {coverageResult && (
            <Text style={coverageResult.available ? styles.success : styles.error}>
              {coverageResult.available
                ? `Good news — we can serve this location (nearest node ~${coverageResult.distanceKm} km away).`
                : "Sorry, we don't currently have coverage at this location."}
            </Text>
          )}

          {geoState === "error" && geoError && <Text style={styles.error}>{geoError}</Text>}
          {(localError || lastError) && <Text style={styles.error}>{localError ?? lastError}</Text>}

          <TouchableOpacity
            style={[styles.button, geoState === "requesting" && styles.buttonDisabled]}
            disabled={geoState === "requesting"}
            onPress={handleTrackLocationPress}
          >
            {geoState === "requesting" ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>{pin ? "Update My Location" : "Track My Location"}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.buttonSecondary, !pin && styles.buttonDisabled]}
            disabled={!pin || checking}
            onPress={handleCheckCoverage}
          >
            {checking ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={styles.buttonSecondaryText}>Check coverage</Text>
            )}
          </TouchableOpacity>

          {coverageResult?.available && (
            <TouchableOpacity style={styles.buttonSecondary} onPress={() => setStep("plan")}>
              <Text style={styles.buttonSecondaryText}>Continue</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity style={styles.linkWrap} onPress={() => navigation.navigate("Login")}>
            <Text style={styles.link}>Already have an account? Sign in</Text>
          </TouchableOpacity>

          <Modal
            visible={consentVisible}
            transparent
            animationType="fade"
            onRequestClose={() => setConsentVisible(false)}
          >
            <View style={styles.modalBackdrop}>
              <View style={styles.modalCard}>
                <Text style={styles.modalTitle}>Share your location?</Text>
                <Text style={styles.modalBody}>
                  NAP-IQ uses your device's current location to verify your installation
                  address is real and to check service coverage there. Your location is
                  only used for this application and isn't tracked afterward.
                </Text>
                <TouchableOpacity
                  style={styles.consentRow}
                  onPress={() => setConsentAgreed(!consentAgreed)}
                  activeOpacity={0.8}
                >
                  <View style={[styles.checkbox, consentAgreed && styles.checkboxChecked]}>
                    {consentAgreed && <Text style={styles.checkboxMark}>✓</Text>}
                  </View>
                  <Text style={styles.consentLabel}>
                    I agree to share my device's current location for this application.
                  </Text>
                </TouchableOpacity>
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={styles.modalCancel}
                    onPress={() => setConsentVisible(false)}
                  >
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalConfirm, !consentAgreed && styles.buttonDisabled]}
                    disabled={!consentAgreed}
                    onPress={handleConsentConfirm}
                  >
                    <Text style={styles.buttonText}>Allow &amp; continue</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.title}>Apply for service</Text>
          <Text style={styles.subtitle}>
            {step === "plan" && "Step 2 of 3 — Choose a plan"}
            {step === "details" && "Step 3 of 3 — Your details"}
          </Text>

          {step === "plan" && (
            <>
              {plans.map((plan) => (
                <TouchableOpacity
                  key={plan}
                  style={[styles.planOption, selectedPlan === plan && styles.planOptionSelected]}
                  onPress={() => setSelectedPlan(plan)}
                >
                  <Text style={styles.planOptionText}>{plan}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[styles.button, !selectedPlan && styles.buttonDisabled]}
                disabled={!selectedPlan}
                onPress={() => setStep("details")}
              >
                <Text style={styles.buttonText}>Continue</Text>
              </TouchableOpacity>
            </>
          )}

          {step === "details" && (
            <>
              <TextInput style={styles.input} placeholder="Full name" placeholderTextColor={colors.textFaint} value={fullName} onChangeText={setFullName} />
              <TextInput style={styles.input} placeholder="Installation address" placeholderTextColor={colors.textFaint} value={address} onChangeText={setAddress} />
              <TextInput style={styles.input} placeholder="Email" placeholderTextColor={colors.textFaint} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
              <TextInput style={styles.input} placeholder="Phone number" placeholderTextColor={colors.textFaint} keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
              <TextInput style={styles.input} placeholder="Choose a username" placeholderTextColor={colors.textFaint} autoCapitalize="none" value={username} onChangeText={setUsername} />
              <TextInput style={styles.input} placeholder="Password" placeholderTextColor={colors.textFaint} secureTextEntry value={password} onChangeText={setPassword} />
              <TextInput style={styles.input} placeholder="Confirm password" placeholderTextColor={colors.textFaint} secureTextEntry value={confirmPassword} onChangeText={setConfirmPassword} />

              {(localError || lastError) && <Text style={styles.error}>{localError ?? lastError}</Text>}

              <TouchableOpacity style={[styles.button, submitting && styles.buttonDisabled]} disabled={submitting} onPress={handleSubmit}>
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Submit application</Text>}
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity style={styles.linkWrap} onPress={() => navigation.navigate("Login")}>
            <Text style={styles.link}>Already have an account? Sign in</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 48 },
  locationStepContainer: { flex: 1, padding: 24, paddingBottom: 24 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700", marginBottom: 4 },
  subtitle: { color: colors.textFaint, fontSize: 14, marginBottom: 16 },
  // flex: 1 lets the map claim whatever room the rest of the step 1
  // layout (title, subtitle, hint, buttons, link) doesn't need —
  // "expand to fill the blank space, but stay short of full screen"
  // in practice, since those fixed-height siblings still reserve
  // their own space above and below it.
  mapWrap: { flex: 1, minHeight: 260, borderRadius: 12, overflow: "hidden", marginBottom: 8 },
  map: { flex: 1 },
  hint: { color: colors.textFaint, fontSize: 12, marginBottom: 12 },
  input: {
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  planOption: {
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  planOptionSelected: { borderColor: colors.primary },
  planOptionText: { color: colors.text, fontSize: 15 },
  button: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  buttonSecondary: { borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 12, borderWidth: 1, borderColor: colors.primary },
  buttonSecondaryText: { color: colors.primary, fontSize: 16, fontWeight: "600" },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  success: { color: "#4CD97B", marginBottom: 12, fontSize: 13 },
  error: { color: colors.danger, marginBottom: 12, fontSize: 13 },
  linkWrap: { marginTop: 20, alignItems: "center" },
  link: { color: colors.primary, fontSize: 13 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: "700", marginBottom: 10 },
  modalBody: { color: colors.textFaint, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  consentRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 20 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
    marginTop: 1,
  },
  checkboxChecked: { backgroundColor: colors.primary },
  checkboxMark: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  consentLabel: { color: colors.text, fontSize: 13, flex: 1, lineHeight: 18 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end" },
  modalCancel: { paddingVertical: 12, paddingHorizontal: 16, marginRight: 8 },
  modalCancelText: { color: colors.textFaint, fontSize: 14, fontWeight: "600" },
  modalConfirm: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18, alignItems: "center" },
});
