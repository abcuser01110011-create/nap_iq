import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/shared";

/**
 * Sign-in / sign-out loading overlay — a mobile port of the website's
 * static/css/auth-transition.css + static/js/auth-transition.js.
 *
 * A full-screen branded overlay that fades in, shows a gently
 * pulsing logo and a progress bar that fills over `durationMs`, then
 * fades back out. This component doesn't own the network call — the
 * screen that renders it is expected to run the real request and a
 * matching minimum-duration timer side by side (e.g. via
 * Promise.all) and stop passing `visible` once both are done. That
 * way a slow request never gets cut off early, and a fast one still
 * gets the full minimum "showtime" instead of a jarring flash.
 * `durationMs` is expected to come from the caller's own
 * network-quality check (see utils/networkQuality.ts) so the bar's
 * pace roughly matches how long the real request is likely to take.
 *
 * Rendered with shared/brand colors (not the signed-in role's theme)
 * since it's shown both before login (no role known yet) and during
 * logout (role about to go away) — same reasoning as theme/shared.ts.
 */

export type AuthTransitionKind = "signin" | "signout";

const TITLES: Record<AuthTransitionKind, string> = {
  signin: "Signing you in",
  signout: "Signing out",
};

const ACCENT = "#5B8CFF";

export interface AuthTransitionOverlayProps {
  visible: boolean;
  kind: AuthTransitionKind;
  /** Should match the minimum-duration timer the caller races the
   * real request against, so the progress bar finishes right as the
   * overlay is about to be dismissed. Pass a value from
   * utils/networkQuality.ts to size this to the current connection;
   * defaults to 3000ms if the caller doesn't have one to hand. */
  durationMs?: number;
}

export default function AuthTransitionOverlay({ visible, kind, durationMs = 3000 }: AuthTransitionOverlayProps) {
  const title = TITLES[kind];
  const fade = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const progress = useRef(new Animated.Value(0)).current;
  // Kept mounted for the ~250ms fade-out, then removed — rather than
  // vanishing the instant `visible` flips false.
  const [rendered, setRendered] = useState(visible);

  // Logo fade pulse loop — runs continuously regardless of overlay
  // visibility so it's never mid-flicker when the overlay fades in.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      progress.setValue(0);
      Animated.timing(fade, { toValue: 1, duration: 250, easing: Easing.ease, useNativeDriver: true }).start();
      Animated.timing(progress, {
        toValue: 1,
        duration: durationMs,
        easing: Easing.linear,
        useNativeDriver: false, // width can't use the native driver
      }).start();
      return;
    }

    Animated.timing(fade, { toValue: 0, duration: 250, easing: Easing.ease, useNativeDriver: true }).start(() => {
      setRendered(false);
    });
  }, [visible, durationMs, fade, progress]);

  if (!rendered) return null;

  const barWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]}>
      <View style={styles.panel}>
        <Animated.View style={[styles.iconBox, { opacity: pulse }]}>
          <Image
            source={require("../../assets/auth-transition-logo.png")}
            style={styles.logo}
            resizeMode="contain"
          />
        </Animated.View>

        <Text style={styles.title}>{title}</Text>

        <View style={styles.progressTrack}>
          <Animated.View style={[styles.progressBar, { width: barWidth }]} />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    elevation: 20,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  panel: {
    alignItems: "center",
    paddingHorizontal: 24,
  },
  iconBox: {
    width: 90,
    height: 100,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  logo: {
    width: "100%",
    height: "100%",
  },
  title: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 22,
  },
  progressTrack: {
    width: 220,
    height: 2,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  },
  progressBar: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: ACCENT,
  },
});
