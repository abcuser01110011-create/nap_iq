import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/shared";

/**
 * Sign-in / sign-out loading overlay — a mobile port of the website's
 * static/css/auth-transition.css + static/js/auth-transition.js.
 *
 * A full-screen branded overlay that fades in, shows a pair of
 * expanding/fading "ping" rings and a breathing logo, a step-by-step
 * status list, and a progress bar that fills over `durationMs`, then
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
 * The step list (below) mirrors auth-transition.js's CONFIGS exactly,
 * with each step flipping from "pending" to "active" to "done" at
 * evenly-spaced points across `durationMs` — same
 * `duration * (index + 1) / (stepCount + 1)` scheduling the website
 * uses. There's no live network-quality readout line here (RN has no
 * exact equivalent of the website's Network Information API probe,
 * and the connection tier already drives `durationMs` itself via
 * getNetworkQualityDuration()), so this intentionally leaves that one
 * row out rather than faking a number.
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

// Same copy/step-count as auth-transition.js's CONFIGS.
const STEPS: Record<AuthTransitionKind, string[]> = {
  signin: ["Verifying credentials", "Establishing secure tunnel", "Syncing topology"],
  signout: ["Closing active session", "Clearing local cache"],
};

const ACCENT = "#5B8CFF";

// Matches the website's ping-ring timing (auth-transition.css:
// authTransitionPing 0.6s, second ring delayed 0.3s).
const PING_DURATION_MS = 600;
const PING_DELAY_MS = 300;

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

/** One expanding-and-fading ring, looped indefinitely once mounted.
 * `delayMs` staggers the second ring the same way the website's
 * `.auth-transition-ping--delay` does. */
function PingRing({ delayMs }: { delayMs: number }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: PING_DURATION_MS,
        delay: delayMs,
        easing: Easing.bezier(0.2, 0.6, 0.4, 1),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [anim, delayMs]);

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1.35] });
  const opacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] });

  return <Animated.View style={[styles.pingRing, { opacity, transform: [{ scale }] }]} />;
}

/** The step-by-step status list under the title, advancing on a fixed
 * schedule spread across `durationMs` — see the component docstring
 * for how that schedule mirrors the website's runStepAnimation(). */
function StepList({ steps, durationMs, active }: { steps: string[]; durationMs: number; active: boolean }) {
  const [doneCount, setDoneCount] = useState(0);

  useEffect(() => {
    if (!active) {
      setDoneCount(0);
      return;
    }
    const timers = steps.map((_, index) => {
      const atTime = Math.round((durationMs * (index + 1)) / (steps.length + 1));
      return setTimeout(() => setDoneCount((count) => Math.max(count, index + 1)), atTime);
    });
    return () => timers.forEach(clearTimeout);
  }, [active, durationMs, steps]);

  return (
    <View style={styles.stepList}>
      {steps.map((label, index) => {
        const state = index < doneCount ? "done" : index === doneCount ? "active" : "pending";
        return (
          <View key={label} style={[styles.step, state !== "pending" && styles.stepEmphasized]}>
            <View style={[styles.stepIcon, state !== "pending" && styles.stepIconLit]}>
              {state === "active" && <View style={styles.stepDot} />}
            </View>
            <Text style={styles.stepLabel}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

export default function AuthTransitionOverlay({ visible, kind, durationMs = 3000 }: AuthTransitionOverlayProps) {
  const title = TITLES[kind];
  const steps = STEPS[kind];
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
        <View style={styles.iconRing}>
          <PingRing delayMs={0} />
          <PingRing delayMs={PING_DELAY_MS} />
          <Animated.View style={[styles.iconBox, { opacity: pulse }]}>
            <Image
              source={require("../../assets/auth-transition-logo.png")}
              style={styles.logo}
              resizeMode="contain"
            />
          </Animated.View>
        </View>

        <Text style={styles.title}>{title}</Text>

        <StepList steps={steps} durationMs={durationMs} active={visible} />

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
  iconRing: {
    width: 90,
    height: 90,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  pingRing: {
    position: "absolute",
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 2.5,
    borderColor: "rgba(91, 140, 255, 0.55)",
  },
  iconBox: {
    width: 64,
    height: 71,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: "100%",
    height: "100%",
  },
  title: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 16,
  },
  stepList: {
    alignSelf: "flex-start",
    marginBottom: 20,
    gap: 8,
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    opacity: 0.55,
  },
  stepEmphasized: {
    opacity: 1,
  },
  stepIcon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "rgba(91, 140, 255, 0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  stepIconLit: {
    backgroundColor: ACCENT,
    borderColor: ACCENT,
  },
  stepDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "#FFFFFF",
  },
  stepLabel: {
    fontSize: 13,
    color: "rgba(226, 232, 255, 0.85)",
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

