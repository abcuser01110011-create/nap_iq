import React, { useRef, useState } from "react";
import {
  Animated,
  StyleProp,
  StyleSheet,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from "react-native";
import { colors } from "../theme/shared";

type Props = TextInputProps & {
  /** Field label. Behaves like a placeholder when the field is empty and
   * unfocused, then floats above the value once the user focuses or types —
   * so it never disappears the way a plain `placeholder` does. */
  label: string;
  /** Style override for the outer wrapper (border/background/margin). */
  containerStyle?: StyleProp<ViewStyle>;
  /** Optional element rendered on the right of the input, e.g. an eye icon
   * button for password fields. Kept outside the animated label so it never
   * shifts. */
  rightAccessory?: React.ReactNode;
};

/**
 * Mobile text field with a floating (Material-style) label instead of a
 * `placeholder`. A plain placeholder vanishes the instant the user types a
 * character, which loses context on small mobile screens (easy to forget
 * which field you're in, especially with autofill or when glancing away).
 * This keeps the label visible at all times: centered like a placeholder
 * when empty/unfocused, animated up and shrunk once focused or filled.
 */
export default function FloatingLabelInput({
  label,
  value,
  containerStyle,
  rightAccessory,
  onFocus,
  onBlur,
  style,
  ...rest
}: Props) {
  const [focused, setFocused] = useState(false);
  const hasValue = !!value && value.length > 0;
  const floated = useRef(new Animated.Value(hasValue ? 1 : 0)).current;

  const animateTo = (toValue: 0 | 1) => {
    Animated.timing(floated, {
      toValue,
      duration: 150,
      useNativeDriver: false,
    }).start();
  };

  const handleFocus: TextInputProps["onFocus"] = (e) => {
    setFocused(true);
    animateTo(1);
    onFocus?.(e);
  };

  const handleBlur: TextInputProps["onBlur"] = (e) => {
    setFocused(false);
    if (!hasValue) animateTo(0);
    onBlur?.(e);
  };

  const labelStyle = {
    top: floated.interpolate({ inputRange: [0, 1], outputRange: [17, 6] }),
    fontSize: floated.interpolate({ inputRange: [0, 1], outputRange: [16, 12] }),
    color: focused ? colors.primary : colors.textFaint,
  };

  return (
    <View style={[styles.wrap, containerStyle]}>
      <View style={styles.field}>
        <Animated.Text style={[styles.label, labelStyle]} numberOfLines={1}>
          {label}
        </Animated.Text>
        <TextInput
          {...rest}
          value={value}
          onFocus={handleFocus}
          onBlur={handleBlur}
          style={[styles.input, style]}
          placeholder={undefined}
          accessibilityLabel={label}
        />
      </View>
      {rightAccessory}
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
    minHeight: 56,
  },
  field: {
    flex: 1,
    justifyContent: "center",
  },
  label: {
    position: "absolute",
    left: 14,
  },
  input: {
    paddingHorizontal: 14,
    paddingTop: 22,
    paddingBottom: 8,
    color: colors.text,
    fontSize: 16,
  },
});
