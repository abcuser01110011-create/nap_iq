import React, { useEffect, useState, useRef } from "react";
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
import { WebView } from "react-native-webview";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth } from "../auth/AuthContext";
import { colors } from "../theme/shared";
import type { AuthStackParamList } from "../navigation/RootNavigator";

type LatLng = { latitude: number; longitude: number };

type Props = NativeStackScreenProps<AuthStackParamList, "Register">;

type Step = "location" | "plan" | "details";

// Manila as a reasonable default map center — first pin drop replaces
// this, it's never submitted as-is.
const DEFAULT_CENTER: LatLng = { latitude: 14.5995, longitude: 120.9842 };

// Builds the HTML page that runs inside the WebView. Uses Leaflet.js
// pulling free OpenStreetMap tiles — no Google Maps SDK, no API key,
// no billing account required. Tapping/dragging the pin posts the
// coordinate back to React Native via window.ReactNativeWebView.postMessage.
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
        const map = L.map('map').setView([${center.latitude}, ${center.longitude}], 13);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        let marker = null;

        function sendPin(lat, lng) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ latitude: lat, longitude: lng }));
        }

        function placeMarker(lat, lng) {
          if (marker) {
            marker.setLatLng([lat, lng]);
          } else {
            marker = L.marker([lat, lng], { draggable: true }).addTo(map);
            marker.on('dragend', function (e) {
              const pos = marker.getLatLng();
              sendPin(pos.lat, pos.lng);
            });
          }
        }

        map.on('click', function (e) {
          placeMarker(e.latlng.lat, e.latlng.lng);
          sendPin(e.latlng.lat, e.latlng.lng);
        });
      </script>
    </body>
    </html>
  `;
}

export default function RegisterScreen({ navigation }: Props) {
  const { register, lastError } = useAuth();

  const [step, setStep] = useState<Step>("location");
  const [pin, setPin] = useState<LatLng | null>(null);
  const [checking, setChecking] = useState(false);
  const [coverageResult, setCoverageResult] = useState<{ available: boolean; distanceKm?: number } | null>(null);

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

  const handleMapMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      setPin({ latitude: data.latitude, longitude: data.longitude });
      setCoverageResult(null);
    } catch {
      // ignore malformed messages
    }
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
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Apply for service</Text>
        <Text style={styles.subtitle}>
          {step === "location" && "Step 1 of 3 — Drop a pin at your installation address"}
          {step === "plan" && "Step 2 of 3 — Choose a plan"}
          {step === "details" && "Step 3 of 3 — Your details"}
        </Text>

        {step === "location" && (
          <>
            <View style={styles.mapWrap}>
              <WebView
                ref={webviewRef}
                originWhitelist={["*"]}
                source={{ html: buildMapHtml(DEFAULT_CENTER) }}
                onMessage={handleMapMessage}
                style={styles.map}
              />
            </View>
            <Text style={styles.hint}>Tap the map to drop a pin, drag to fine-tune.</Text>

            {coverageResult && (
              <Text style={coverageResult.available ? styles.success : styles.error}>
                {coverageResult.available
                  ? `Good news — we can serve this location (nearest node ~${coverageResult.distanceKm} km away).`
                  : "Sorry, we don't currently have coverage at this location."}
              </Text>
            )}

            {(localError || lastError) && <Text style={styles.error}>{localError ?? lastError}</Text>}

            <TouchableOpacity
              style={[styles.button, !pin && styles.buttonDisabled]}
              disabled={!pin || checking}
              onPress={handleCheckCoverage}
            >
              {checking ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Check coverage</Text>}
            </TouchableOpacity>

            {coverageResult?.available && (
              <TouchableOpacity style={styles.buttonSecondary} onPress={() => setStep("plan")}>
                <Text style={styles.buttonSecondaryText}>Continue</Text>
              </TouchableOpacity>
            )}
          </>
        )}

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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 24, paddingBottom: 48 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700", marginBottom: 4 },
  subtitle: { color: colors.textFaint, fontSize: 14, marginBottom: 20 },
  mapWrap: { height: 220, borderRadius: 12, overflow: "hidden", marginBottom: 8 },
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
});
