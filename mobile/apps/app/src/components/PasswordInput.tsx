import React, { useState } from "react";
import {
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
  ViewStyle,
  TextInputProps,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/shared";

type Props = Omit<TextInputProps, "secureTextEntry" | "style"> & {
  /** Optional style override for the outer wrapper (defaults match the plain `input` style used elsewhere on these screens). */
  containerStyle?: ViewStyle;
};

/**
 * Drop-in replacement for a plain `<TextInput secureTextEntry />` that adds
 * a tappable eye icon to show/hide the typed password. Used on both
 * LoginScreen and RegisterScreen so the toggle behaves identically
 * everywhere a password is entered.
 */
export default function PasswordInput({ containerStyle, placeholderTextColor, ...rest }: Props) {
  const [hidden, setHidden] = useState(true);

  return (
    <View style={[styles.wrap, containerStyle]}>
      <TextInput
        {...rest}
        style={styles.input}
        placeholderTextColor={placeholderTextColor ?? colors.textFaint}
        secureTextEntry={hidden}
      />
      <TouchableOpacity
        style={styles.iconButton}
        onPress={() => setHidden((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel={hidden ? "Show password" : "Hide password"}
        // Keeps the tap from stealing focus/closing the keyboard before
        // the press registers, same reasoning as the web app's
        // password-toggle.js mousedown guard.
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons
          name={hidden ? "eye-outline" : "eye-off-outline"}
          size={20}
          color={colors.textFaint}
        />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
  },
  iconButton: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
});
