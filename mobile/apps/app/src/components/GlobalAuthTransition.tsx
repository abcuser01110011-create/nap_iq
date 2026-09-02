import React from "react";
import AuthTransitionOverlay from "./AuthTransitionOverlay";
import { useAuth } from "../auth/AuthContext";

/**
 * Mounts the one and only <AuthTransitionOverlay> instance, as a
 * sibling of <RootNavigator /> in App.tsx — not inside any individual
 * screen. See AuthTransitionOverlay.tsx's docstring for why: a single
 * root-level instance is immune to the per-screen Android Modal +
 * keyboard-resize bug, covers tab bars on the sign-out side, and
 * survives RootNavigator swapping its whole tree on login/logout
 * instead of unmounting mid-fade.
 *
 * Deliberately just a thin read of AuthContext's `authTransition`
 * state — LoginScreen and both ProfileScreens call
 * showAuthTransition()/hideAuthTransition() to drive it, they don't
 * render an overlay themselves.
 */
export default function GlobalAuthTransition() {
  const { authTransition } = useAuth();
  return (
    <AuthTransitionOverlay
      visible={authTransition.visible}
      kind={authTransition.kind}
      durationMs={authTransition.durationMs}
    />
  );
}
