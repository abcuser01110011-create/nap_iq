import { StyleSheet } from "react-native";

/**
 * Shared look for the two signed-out screens (Login, Register) — a
 * mobile port of the website's dark "operations console" theme (see
 * app/templates/auth/login.html + static/css/login.css). Pulled out
 * into its own module, instead of being duplicated per-screen, so
 * the two forms can never quietly drift apart — same card size,
 * same field/button treatment, same colors.
 *
 * Deliberately separate from theme/shared.ts, which several other
 * signed-out-adjacent screens (Register's post-login flow, the
 * offline sync banner, etc.) also import — changing that file's
 * colors would restyle screens nobody asked to change. This module
 * only affects Login and Register.
 */
export const AUTH_COLORS = {
  bg: "#05091a",
  cardBorder: "rgba(255, 255, 255, 0.14)",
  fieldBg: "#0b1330",
  fieldBorder: "rgba(255, 255, 255, 0.1)",
  accent: "#2258e6",
  accentBright: "#3b6bff",
  text: "#eef2ff",
  textMuted: "#8b96b8",
  placeholder: "rgba(203, 213, 255, 0.32)",
  icon: "rgba(226, 232, 255, 0.6)",
  dangerBg: "rgba(220, 53, 69, 0.16)",
  dangerBorder: "rgba(220, 53, 69, 0.4)",
  dangerText: "#ffc2c9",
};

// Both cards share this exact size/shape — 400 matches the
// website's .login-card { max-width: 400px; } — so Login and
// Register always render as the same-sized box regardless of which
// one has more or less content inside it.
export const AUTH_CARD_MAX_WIDTH = 400;

export const authScreenStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: AUTH_COLORS.bg,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: AUTH_CARD_MAX_WIDTH,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: AUTH_COLORS.cardBorder,
    padding: 24,
  },
  brand: {
    alignItems: "center",
    marginBottom: 28,
  },
  brandMark: {
    width: 56,
    height: 56,
    borderRadius: 14,
    marginBottom: 12,
  },
  title: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "700",
  },
  subtitle: {
    color: AUTH_COLORS.textMuted,
    fontSize: 13,
    marginTop: 4,
    textAlign: "center",
  },
  flash: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: AUTH_COLORS.dangerBg,
    borderWidth: 1,
    borderColor: AUTH_COLORS.dangerBorder,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginBottom: 16,
  },
  flashText: {
    color: AUTH_COLORS.dangerText,
    fontSize: 13,
    flexShrink: 1,
  },
  field: {
    marginBottom: 16,
  },
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "rgba(226, 232, 255, 0.85)",
    marginBottom: 6,
  },
  forgotLink: {
    fontSize: 13,
    fontWeight: "600",
    color: AUTH_COLORS.accentBright,
    marginBottom: 6,
  },
  fieldWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: AUTH_COLORS.fieldBg,
    borderWidth: 1,
    borderColor: AUTH_COLORS.fieldBorder,
    borderRadius: 10,
  },
  fieldIcon: {
    marginLeft: 13,
  },
  fieldInput: {
    flex: 1,
    color: AUTH_COLORS.text,
    fontSize: 15,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  fieldInputPassword: {
    paddingRight: 4,
  },
  toggleButton: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  remember: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginBottom: 20,
  },
  rememberBox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  rememberBoxChecked: {
    backgroundColor: AUTH_COLORS.accent,
    borderColor: AUTH_COLORS.accent,
  },
  rememberLabel: {
    fontSize: 13,
    color: "rgba(226, 232, 255, 0.75)",
  },
  hint: {
    color: AUTH_COLORS.textMuted,
    fontSize: 12,
    marginTop: -4,
    marginBottom: 16,
    lineHeight: 17,
  },
  submit: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: AUTH_COLORS.accentBright,
    borderRadius: 10,
    paddingVertical: 14,
  },
  submitDisabled: {
    opacity: 0.5,
  },
  submitText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600",
  },
  linkWrap: {
    marginTop: 18,
    alignItems: "center",
  },
  link: {
    color: AUTH_COLORS.accentBright,
    fontSize: 13,
  },
});
