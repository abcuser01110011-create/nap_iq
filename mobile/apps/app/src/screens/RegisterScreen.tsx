import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { colors } from "../theme/shared";
import FloatingLabelInput from "../components/FloatingLabelInput";
import PasswordInput from "../components/PasswordInput";
import type { AuthStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<AuthStackParamList, "Register">;

/**
 * First step of self-service sign-up — just enough to identify the
 * new account (username + password). There's no "confirm password"
 * field here on purpose: this screen doesn't create the account by
 * itself, it just captures credentials and hands them to
 * ApplyForServiceScreen, which is where they're actually submitted
 * to the backend together with the rest of the application (name,
 * install address, plan, etc.) since register() requires all of
 * that in one call. A brand-new account has no subscription yet, so
 * "Apply for service" is the only next step worth offering here.
 */
export default function RegisterScreen({ navigation }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const canContinue = username.trim().length > 0 && password.length > 0;

  const handleApplyForService = () => {
    if (!canContinue) return;
    if (password.length < 8) {
      setLocalError("Password must be at least 8 characters.");
      return;
    }
    setLocalError(null);
    navigation.navigate("ApplyForService", {
      username: username.trim(),
      password,
    });
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
          onSubmitEditing={handleApplyForService}
        />

        {localError && <Text style={styles.error}>{localError}</Text>}

        <Text style={styles.hint}>You don't have an active subscription yet — apply for service to get connected.</Text>

        <TouchableOpacity
          style={[styles.button, !canContinue && styles.buttonDisabled]}
          onPress={handleApplyForService}
          disabled={!canContinue}
        >
          <Text style={styles.buttonText}>Apply for service</Text>
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
