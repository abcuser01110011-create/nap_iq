import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth } from "../auth/AuthContext";
import AuthTransitionOverlay from "../components/AuthTransitionOverlay";
import { AUTH_COLORS, authScreenStyles as styles } from "../theme/authScreen";
import { getNetworkQualityDuration } from "../utils/networkQuality";
import type { AuthStackParamList } from "../navigation/RootNavigator";

/** Fallback if the network-quality check hasn't resolved yet by the
 * time the overlay needs a number (see handleSubmit) — matches
 * AuthTransitionOverlay's own default. */
const FALLBACK_TRANSITION_MS = 3000;

type Props = NativeStackScreenProps<AuthStackParamList, "Login">;

/**
 * Mobile port of the website's dark "operations console" sign-in
 * page (see app/templates/auth/login.html + static/css/login.css) —
 * same near-black background, icon-prefixed fields, "Keep me signed
 * in" checkbox and arrow submit button. Styles/colors live in
 * theme/authScreen.ts, shared with RegisterScreen, so both cards are
 * always exactly the same size and treatment.
 *
 * One difference from the website on purpose: the website's footer
 * line ("Access is logged and restricted to authorized operators.")
 * doesn't apply here, since this screen is also how new customers
 * get in — so that slot is used for the existing "Don't have an
 * account? Register now" link instead. Tapping it, and Register's
 * "Already have an account?" link back, animate via the AuthStack's
 * navigator-level slide transition (see RootNavigator.tsx) rather
 * than anything owned by this screen.
 *
 * Still one login screen for both technician and customer accounts —
 * this app doesn't ask which you are, or reject an otherwise-valid
 * account for being the "wrong" one. AuthContext derives the role
 * from the login response and RootNavigator routes accordingly.
 */
export default function LoginScreen({ navigation }: Props) {
  const { login, lastError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordHidden, setPasswordHidden] = useState(true);
  // Cosmetic only, matching the website's checkbox: NAP-IQ's session
  // is always persistent regardless of this toggle — there's no
  // separate "short session" mode on the backend to opt out of, so
  // this is kept checked by default and never sent anywhere.
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  // How long the overlay's progress bar takes to fill, sized to the
  // device's current connection so a fast Wi-Fi/5G bar moves quickly
  // and a slow/2G one gets more realistic showtime. Refreshed right
  // before each submit rather than kept constantly in sync, since
  // it's only ever read at that moment.
  const [transitionMs, setTransitionMs] = useState(FALLBACK_TRANSITION_MS);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    // Show the overlay the instant the button is pressed, using the
    // fallback duration as a placeholder — *before* touching
    // getNetworkQualityDuration(). That call goes through NetInfo's
    // native module, and if it's ever slow, hangs, or throws before
    // its own .catch can run (e.g. the native module not being
    // linked in a given build), it must never be able to block the
    // overlay from appearing at all. transitionMs is refined a
    // moment later, in place, once/if the real reading comes back.
    setSubmitting(true);
    setTransitioning(true);
    setTransitionMs(FALLBACK_TRANSITION_MS);

    const durationMs = await getNetworkQualityDuration()
      .then(({ durationMs }) => {
        setTransitionMs(durationMs);
        return durationMs;
      })
      .catch(() => FALLBACK_TRANSITION_MS);

    // Run the real request alongside a minimum-showtime timer, same
    // idea as the website's fixed-delay overlay — a fast response
    // still gets the full animation, a slow one isn't cut short.
    const minShowtime = new Promise((resolve) => setTimeout(resolve, durationMs));
    try {
      await Promise.all([login(username.trim(), password, durationMs), minShowtime]);
    } finally {
      setSubmitting(false);
      setTransitioning(false);
    }
  };

  const handleForgotPress = () => {
    Alert.alert("Forgot password?", "Contact an administrator to reset your password.");
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <View style={styles.brand}>
          <Image
            source={require("../../assets/auth-transition-logo.png")}
            style={styles.brandMark}
            resizeMode="contain"
          />
          <Text style={styles.title}>PG Networks</Text>
          <Text style={styles.subtitle}>Sign in to continue</Text>
        </View>

        {lastError && (
          <View style={styles.flash}>
            <Ionicons name="alert-circle" size={16} color={AUTH_COLORS.dangerText} />
            <Text style={styles.flashText}>{lastError}</Text>
          </View>
        )}

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Username</Text>
          <View style={styles.fieldWrap}>
            <Ionicons name="person-outline" size={17} color={AUTH_COLORS.icon} style={styles.fieldIcon} />
            <TextInput
              style={styles.fieldInput}
              placeholder="Enter your username"
              placeholderTextColor={AUTH_COLORS.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              value={username}
              onChangeText={setUsername}
              editable={!submitting}
              returnKeyType="next"
            />
          </View>
        </View>

        <View style={styles.field}>
          <View style={styles.fieldLabelRow}>
            <Text style={styles.fieldLabel}>Password</Text>
            <TouchableOpacity onPress={handleForgotPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.forgotLink}>Forgot?</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.fieldWrap}>
            <Ionicons name="lock-closed-outline" size={17} color={AUTH_COLORS.icon} style={styles.fieldIcon} />
            <TextInput
              style={[styles.fieldInput, styles.fieldInputPassword]}
              placeholder="Enter your password"
              placeholderTextColor={AUTH_COLORS.placeholder}
              secureTextEntry={passwordHidden}
              autoComplete="password"
              value={password}
              onChangeText={setPassword}
              editable={!submitting}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />
            <TouchableOpacity
              style={styles.toggleButton}
              onPress={() => setPasswordHidden((prev) => !prev)}
              accessibilityRole="button"
              accessibilityLabel={passwordHidden ? "Show password" : "Hide password"}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={passwordHidden ? "eye-outline" : "eye-off-outline"}
                size={18}
                color={AUTH_COLORS.icon}
              />
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={styles.remember}
          onPress={() => setKeepSignedIn((prev) => !prev)}
          activeOpacity={0.7}
        >
          <View style={[styles.rememberBox, keepSignedIn && styles.rememberBoxChecked]}>
            {keepSignedIn && <Ionicons name="checkmark" size={12} color="#ffffff" />}
          </View>
          <Text style={styles.rememberLabel}>Keep me signed in on this device</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.submit, !canSubmit && styles.submitDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <>
              <Text style={styles.submitText}>Sign in</Text>
              <Ionicons name="arrow-forward" size={16} color="#ffffff" />
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.linkWrap} onPress={() => navigation.navigate("Register")}>
          <Text style={styles.link}>Don't have an account? Register now</Text>
        </TouchableOpacity>
      </View>

      <AuthTransitionOverlay visible={transitioning} kind="signin" durationMs={transitionMs} />
    </KeyboardAvoidingView>
  );
}
