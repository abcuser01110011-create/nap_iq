/**
 * Used only where the screen can't yet know which role's theme
 * applies — the login screen and the cold-start loading spinner, both
 * rendered before `AuthContext` knows the signed-in user's role.
 * Once signed in, technician screens use theme/technician.ts and
 * customer screens use theme/customer.ts, same as the two standalone
 * apps did.
 */
export const colors = {
  bg: "#0B1F3A",
  card: "#122A4D",
  border: "#1F3A63",
  text: "#FFFFFF",
  textMuted: "#C7D0DE",
  textFaint: "#8896AB",
  primary: "#2E7DFF",
  danger: "#FF6B6B",
};
