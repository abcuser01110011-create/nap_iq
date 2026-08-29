import React, { useState } from "react";
import {
  ActivityIndicator,
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
import { AUTH_COLORS, authScreenStyles as styles } from "../theme/authScreen";
import type { AuthStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<AuthStackParamList, "Register">;

/**
 * Pure self-service sign-up (Phase 30) — just enough to create an
 * account (username + password). There's no "confirm password" field
 * here on purpose, same as before. Unlike the pre-Phase-30 version,
 * this screen creates the account itself by calling register()
 * directly: a successful register() signs the new account straight
 * in, and RootNavigator then drops it onto the dashboard, where
 * "Apply for service" is offered as an optional next step (see
 * HomeScreen) rather than being required before the account exists.
 * The account is saved server-side either way, so this same
 * username/password can log back in later even if the person never
 * applies for service.
 *
 * Styled to match LoginScreen — same card size, same icon fields,
 * same brand mark — via the shared theme/authScreen.ts module so the
 * two never drift apart. No "Forgot?" link or "Keep me signed in"
 * checkbox here since neither applies to a brand-new account.
 */
export default function RegisterScreen({ navigation }: Props) {
  const { register, lastError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordHidden, setPasswordHidden] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canContinue = username.trim().length > 0 && password.length > 0 && !submitting;

  const handleRegister = async () => {
    if (!canContinue) return;
    if (password.length < 8) {
      setLocalError("Password must be at least 8 characters.");
      return;
    }
    setLocalError(null);
    setSubmitting(true);
    try {
      await register({ username: username.trim(), password });
    } finally {
      setSubmitting(false);
    }
  };

  const errorMessage = localError ?? lastError;

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
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>Choose a username and password to get started</Text>
        </View>

        {errorMessage && (
          <View style={styles.flash}>
            <Ionicons name="alert-circle" size={16} color={AUTH_COLORS.dangerText} />
            <Text style={styles.flashText}>{errorMessage}</Text>
          </View>
        )}

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Username</Text>
          <View style={styles.fieldWrap}>
            <Ionicons name="person-outline" size={17} color={AUTH_COLORS.icon} style={styles.fieldIcon} />
            <TextInput
              style={styles.fieldInput}
              placeholder="Choose a username"
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
          <Text style={styles.fieldLabel}>Password</Text>
          <View style={styles.fieldWrap}>
            <Ionicons name="lock-closed-outline" size={17} color={AUTH_COLORS.icon} style={styles.fieldIcon} />
            <TextInput
              style={[styles.fieldInput, styles.fieldInputPassword]}
              placeholder="Choose a password"
              placeholderTextColor={AUTH_COLORS.placeholder}
              secureTextEntry={passwordHidden}
              autoComplete="password"
              value={password}
              onChangeText={setPassword}
              editable={!submitting}
              returnKeyType="done"
              onSubmitEditing={handleRegister}
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

        <Text style={styles.hint}>
          You don't have an active subscription yet — you can apply for service from your dashboard after
          creating your account.
        </Text>

        <TouchableOpacity
          style={[styles.submit, !canContinue && styles.submitDisabled]}
          onPress={handleRegister}
          disabled={!canContinue}
        >
          {submitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <>
              <Text style={styles.submitText}>Create account</Text>
              <Ionicons name="arrow-forward" size={16} color="#ffffff" />
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.linkWrap} onPress={() => navigation.navigate("Login")}>
          <Text style={styles.link}>Already have an account? Sign in</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
