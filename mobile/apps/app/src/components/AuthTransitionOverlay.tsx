import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/shared";

/**
 * Sign-in / sign-out loading overlay — a mobile port of the website's
 * static/css/auth-transition.css + static/js/auth-transition.js.
 *
 * Same idea as the web version: a full-screen branded overlay with a
 * pulsing logo, a step list that advances on a timer, and a progress
 * bar that fills over a fixed minimum duration. Unlike the website
 * (which delays a real <form> submit behind the animation), this
 * component doesn't own the network call — the screen that renders it
 * is expected to run the real request and the minimum-duration timer
 * side by side (e.g. via Promise.all) and stop passing `visible` once
 * both are done. That way a slow request never gets cut off early,
 * and a fast one still gets the full minimum "showtime" instead of a
 * jarring flash.
 *
 * Rendered with shared/brand colors (not the signed-in role's theme)
 * since it's shown both before login (no role known yet) and during
 * logout (role about to go away) — same reasoning as theme/shared.ts.
 */

export type AuthTransitionKind = "signin" | "signout";

const CONFIGS: Record<AuthTransitionKind, { title: string; steps: string[] }> = {
  signin: {
    title: "Signing you in",
    steps: ["Verifying credentials", "Establishing secure tunnel", "Syncing topology"],
  },
  signout: {
    title: "Signing out",
    steps: ["Closing active session", "Clearing local cache"],
  },
};

const ACCENT = "#5B8CFF";
const RING_SIZE = 128;

interface PingRingProps {
  delayMs: number;
}

function PingRing({ delayMs }: PingRingProps) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    anim.setValue(0);
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: 600,
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

  return <Animated.View pointerEvents="none" style={[styles.ping, { transform: [{ scale }], opacity }]} />;
}

export interface AuthTransitionOverlayProps {
  visible: boolean;
  kind: AuthTransitionKind;
  /** Should match the minimum-duration timer the caller races the
   * real request against, so the step list finishes right as the
   * overlay is about to be dismissed. Defaults to 3000ms — same as
   * the website's DURATION_MS. */
  durationMs?: number;
}

export default function AuthTransitionOverlay({ visible, kind, durationMs = 3000 }: AuthTransitionOverlayProps) {
  const config = CONFIGS[kind];
  const fade = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;
  const [activeStep, setActiveStep] = useState(0);

  // Breathing icon loop — runs continuously regardless of visibility
  // so it's never mid-flicker when the overlay fades in.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  useEffect(() => {
    if (!visible) {
      fade.setValue(0);
      progress.setValue(0);
      setActiveStep(0);
      return;
    }

    Animated.timing(fade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      easing: Easing.linear,
      useNativeDriver: false, // width can't use the native driver
    }).start();

    const stepCount = config.steps.length;
    const timers = Array.from({ length: stepCount }, (_, index) => {
      const atTime = Math.round((durationMs * (index + 1)) / (stepCount + 1));
      return setTimeout(() => setActiveStep(index + 1), atTime);
    });

    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, durationMs, kind]);

  if (!visible) return null;

  const iconScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] });
  const barWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <Animated.View style={[styles.overlay, { opacity: fade }]}>
      <View style={styles.panel}>
        <View style={styles.ringWrap}>
          <PingRing delayMs={0} />
          <PingRing delayMs={300} />
          <Animated.View style={[styles.iconBox, { transform: [{ scale: iconScale }] }]}>
            <Image
              source={require("../../assets/auth-transition-logo.png")}
              style={styles.logo}
              resizeMode="contain"
            />
          </Animated.View>
        </View>

        <Text style={styles.title}>{config.title}</Text>

        <View style={styles.steps}>
          {config.steps.map((label, index) => {
            const state = index < activeStep ? "done" : index === activeStep ? "active" : "pending";
            return (
              <View key={label} style={styles.step}>
                <View
                  style={[
                    styles.stepIcon,
                    state === "active" && styles.stepIconActive,
                    state === "done" && styles.stepIconDone,
                  ]}
                >
                  {state === "done" && <Text style={styles.stepCheck}>{"\u2713"}</Text>}
                  {state === "active" && <View style={styles.stepDot} />}
                </View>
                <Text style={[styles.stepLabel, state !== "pending" && styles.stepLabelActive]}>{label}</Text>
              </View>
            );
          })}
        </View>

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
  ringWrap: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  ping: {
    position: "absolute",
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 2.5,
    borderColor: "rgba(91, 140, 255, 0.55)",
  },
  iconBox: {
    width: 90,
    height: 100,
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
    marginBottom: 18,
  },
  steps: {
    alignSelf: "flex-start",
    marginBottom: 22,
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 9,
  },
  stepIcon: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: "rgba(91, 140, 255, 0.35)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  stepIconActive: {
    borderColor: ACCENT,
  },
  stepIconDone: {
    backgroundColor: ACCENT,
    borderColor: ACCENT,
  },
  stepCheck: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
  },
  stepDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: ACCENT,
  },
  stepLabel: {
    color: "rgba(226, 232, 255, 0.55)",
    fontSize: 13.5,
  },
  stepLabelActive: {
    color: "rgba(226, 232, 255, 0.9)",
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
