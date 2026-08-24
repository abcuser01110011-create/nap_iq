import React, { useState } from "react";
import {
  StyleSheet,
  TouchableOpacity,
  ViewStyle,
  TextInputProps,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/shared";
import FloatingLabelInput from "./FloatingLabelInput";

type Props = Omit<TextInputProps, "secureTextEntry" | "style" | "placeholder"> & {
  /** Optional style override for the outer wrapper (defaults match the plain `input` style used elsewhere on these screens). */
  containerStyle?: ViewStyle;
  /** Field label — shown floating above the value, same as every other
   * field, instead of a placeholder that disappears once typing starts. */
  label?: string;
};

/**
 * Drop-in replacement for a plain `<TextInput secureTextEntry />` that adds
 * a tappable eye icon to show/hide the typed password, and a floating label
 * so the field's purpose stays visible while typing. Used on both
 * LoginScreen and RegisterScreen so the toggle behaves identically
 * everywhere a password is entered.
 */
export default function PasswordInput({ containerStyle, label, ...rest }: Props) {
  const [hidden, setHidden] = useState(true);

  return (
    <FloatingLabelInput
      {...rest}
      label={label ?? "Password"}
      containerStyle={containerStyle}
      secureTextEntry={hidden}
      rightAccessory={
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
      }
    />
  );
}

const styles = StyleSheet.create({
  iconButton: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
});
