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

type Props = NativeStackScreenProps<AuthStackParamList, "Login">;

/**
 * One login screen for both technician and customer accounts — this
 * app no longer needs to ask which you are, or reject an otherwise-
 * valid account for being the "wrong" one. AuthContext derives the
 * role from the login response and RootNavigator routes accordingly.
 */
export default function LoginScreen({ navigation }: Props) {
  const { login, lastError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await login(username.trim(), password);
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
        <Text style={styles.title}>NAP-IQ</Text>
        <Text style={styles.subtitle}>Sign in with your technician or customer account</Text>

        <FloatingLabelInput
          containerStyle={styles.input}
          label="Username"
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
          editable={!submitting}
          returnKeyType="next"
        />
        <PasswordInput
          containerStyle={styles.passwordWrap}
          label="Password"
          value={password}
          onChangeText={setPassword}
          editable={!submitting}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />

        {lastError && <Text style={styles.error}>{lastError}</Text>}

        <TouchableOpacity
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.linkWrap} onPress={() => navigation.navigate("Register")}>
          <Text style={styles.link}>New customer? Apply for service</Text>
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
