import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";

/**
 * Rough connection-quality tiers, used to size how long the sign-in
 * transition overlay (AuthTransitionOverlay) shows for — a fast
 * connection gets a quick, snappy transition; a slow or spotty one
 * gets more showtime so the progress bar doesn't finish and then
 * just sit there waiting on a still-pending request.
 *
 * NetInfo doesn't expose a reliable, cross-platform signal-strength
 * number (Wi-Fi `strength` is Android-only, and there's no RSSI for
 * cellular), so this classifies by connection *type* instead —
 * Wi-Fi/ethernet vs. cellular generation vs. no/uncertain
 * connectivity — which is what's actually available on both
 * platforms.
 */
export type NetworkQuality = "fast" | "moderate" | "slow" | "offline";

/** Progress-bar / overlay duration for each tier, in ms. */
export const NETWORK_QUALITY_DURATION_MS: Record<NetworkQuality, number> = {
  fast: 1800,
  moderate: 2800,
  slow: 4200,
  // The login call will usually fail quickly when there's no
  // connectivity at all, but keep the same showtime as "slow" so the
  // overlay doesn't flash in and out before the error has a chance
  // to render.
  offline: 4200,
};

export function classifyNetworkQuality(state: NetInfoState): NetworkQuality {
  if (!state.isConnected || state.isInternetReachable === false) return "offline";

  if (state.type === "wifi" || state.type === "ethernet") return "fast";

  if (state.type === "cellular") {
    const generation = state.details?.cellularGeneration;
    if (generation === "5g" || generation === "4g") return "fast";
    if (generation === "3g") return "moderate";
    return "slow"; // 2g or unreported
  }

  // Bluetooth/VPN/other or "unknown" transport — treat as moderate
  // rather than assuming the best or the worst case.
  return "moderate";
}

/** Fetches the current connection state and returns its quality tier
 * plus the transition duration that tier maps to. */
export async function getNetworkQualityDuration(): Promise<{ quality: NetworkQuality; durationMs: number }> {
  const state = await NetInfo.fetch();
  const quality = classifyNetworkQuality(state);
  return { quality, durationMs: NETWORK_QUALITY_DURATION_MS[quality] };
}
