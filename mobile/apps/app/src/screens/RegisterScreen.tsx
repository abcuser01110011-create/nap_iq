import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth } from "../auth/AuthContext";
import { colors } from "../theme/shared";
import FloatingLabelInput from "../components/FloatingLabelInput";
import PasswordInput from "../components/PasswordInput";
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
 */
export default function RegisterScreen({ navigation }: Props) {
  const { register, lastError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canContinue = username.trim().length > 0 && password.length > 0;

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

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>Choose a username and password to get started</Text>

        <FloatingLabelInput
          containerStyle={styles.input}
          label="Username"
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
          returnKeyType="next"
        />
        <PasswordInput
          containerStyle={styles.passwordWrap}
          label="Password"
          value={password}
          onChangeText={setPassword}
          returnKeyType="done"
          onSubmitEditing={handleRegister}
        />

        {(localError || lastError) && <Text style={styles.error}>{localError ?? lastError}</Text>}

        <Text style={styles.hint}>You don't have an active subscription yet — you can apply for service from your dashboard after creating your account.</Text>

        <TouchableOpacity
          style={[styles.button, (!canContinue || submitting) && styles.buttonDisabled]}
          onPress={handleRegister}
          disabled={!canContinue || submitting}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Create account</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.linkWrap} onPress={() => navigation.navigate("Login")}>
          <Text style={styles.link}>Already have an account? Sign in</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    padding: 24,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 24,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: "700",
    marginBottom: 4,
  },
  subtitle: {
    color: colors.textFaint,
    fontSize: 14,
    marginBottom: 24,
  },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
  },
  passwordWrap: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
  },
  hint: {
    color: colors.textFaint,
    fontSize: 12,
    marginTop: 4,
    marginBottom: 12,
  },
  error: {
    color: colors.danger,
    marginBottom: 12,
    fontSize: 13,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
  linkWrap: {
    marginTop: 18,
    alignItems: "center",
  },
  link: {
    color: colors.primary,
    fontSize: 13,
  },
});
