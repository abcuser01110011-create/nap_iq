import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import * as Location from "expo-location";
import { colors } from "../theme/technician";

interface Props {
  destinationLatitude: number;
  destinationLongitude: number;
  destinationLabel: string;
  isOnline: boolean;
  onOpenExternal: () => void;
}

// Same public OSRM driving-route service the web dispatch board already
// calls (see app/static/js/nav-routing.js's header comment) — reused here
// so the field assistant app draws the same real road geometry, not a
// straight line, between the technician's live GPS fix and the job.
const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving";

// How often a fresh GPS fix is allowed to trigger a new OSRM request —
// keeps the map responsive to real movement without hammering the public
// routing service on every watchPositionAsync callback.
const ROUTE_REFRESH_MS = 15000;

// Zoom level "Recenter" and the initial follow-lock snap the map to once a
// GPS fix is available — close enough to be genuinely useful for
// navigating, without needing a per-frame zoom decision.
const FOLLOW_ZOOM = 17;

/**
 * Builds the standalone HTML page rendered inside the WebView. Leaflet
 * itself (and its tiles) are fetched over the network, same tradeoff
 * JobLocationMap already makes for its native-maps preview — there's no
 * offline tile cache in this build, so this component is gated behind
 * `isOnline` by the caller.
 *
 * The map is fully interactive (pan/zoom/pinch all enabled) so the
 * technician can navigate to the job without ever leaving the app — no
 * more hand-off to Google/Apple Maps just to see where they're going.
 * It ships with a "follow" mode: while active, the view re-centers on
 * the technician's live position on every GPS fix, same as a normal
 * turn-by-turn app. Dragging the map turns follow off (so a technician
 * can freely look around the route); tapping "Recenter" from the RN side
 * turns it back on.
 */
const buildHtml = (destLat: number, destLng: number) => `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; background: #0B1F3A; }
  .leaflet-control-zoom { margin-top: 10px !important; margin-right: 10px !important; }
  .napiq-tech-dot {
    width: 18px; height: 18px; border-radius: 9px;
    background: #2E7DFF; border: 3px solid #FFFFFF;
    box-shadow: 0 0 0 5px rgba(46, 125, 255, 0.35);
  }
  .napiq-dest-pin {
    width: 16px; height: 16px; border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
    background: #FF6B6B; border: 2px solid #FFFFFF;
  }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var DEST = { lat: ${destLat}, lng: ${destLng} };
  var map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    dragging: true,
    touchZoom: true,
    doubleClickZoom: true,
    scrollWheelZoom: true,
    boxZoom: false,
    keyboard: false,
    tap: true
  }).setView([DEST.lat, DEST.lng], 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  var destIcon = L.divIcon({ className: '', html: '<div class="napiq-dest-pin"></div>', iconSize: [16, 16] });
  var techIcon = L.divIcon({ className: '', html: '<div class="napiq-tech-dot"></div>', iconSize: [18, 18] });

  L.marker([DEST.lat, DEST.lng], { icon: destIcon }).addTo(map);

  var techMarker = null;
  var routeLine = null;
  var lastFetch = 0;
  var haveFittedOnce = false;
  var following = true;

  function post(message) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  // A user-initiated drag/zoom means the technician wants to look
  // around — drop out of follow mode so their pan isn't fought on the
  // next GPS fix. Panning triggered by our own setView() calls below
  // does NOT come through here as a user gesture in Leaflet, so this
  // only fires for real touch input.
  map.on('dragstart zoomstart', function (e) {
    if (e.originalEvent) {
      following = false;
      post({ type: 'follow', following: false });
    }
  });

  window.recenterMap = function () {
    following = true;
    if (techMarker) {
      map.setView(techMarker.getLatLng(), Math.max(map.getZoom(), ${FOLLOW_ZOOM}));
    }
    post({ type: 'follow', following: true });
  };

  function fetchRoute(lat, lng) {
    var url = '${OSRM_BASE_URL}/' + lng + ',' + lat + ';' + DEST.lng + ',' + DEST.lat + '?overview=full&geometries=geojson';
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.routes || !data.routes.length) {
          post({ type: 'error', message: 'No route found' });
          return;
        }
        var route = data.routes[0];
        var coords = route.geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
        if (routeLine) map.removeLayer(routeLine);
        routeLine = L.polyline(coords, { color: '#2E7DFF', weight: 5, opacity: 0.85 }).addTo(map);
        if (!haveFittedOnce) {
          // First route of the session: show the whole path from here
          // to the job once, so the technician gets their bearings.
          map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
          haveFittedOnce = true;
        }
        post({ type: 'route', distanceKm: route.distance / 1000, durationMin: route.duration / 60 });
      })
      .catch(function () {
        post({ type: 'error', message: 'Route unavailable' });
      });
  }

  window.updateTechLocation = function (lat, lng) {
    var isFirstFix = !techMarker;
    if (!techMarker) {
      techMarker = L.marker([lat, lng], { icon: techIcon }).addTo(map);
    } else {
      techMarker.setLatLng([lat, lng]);
    }

    if (following && !isFirstFix) {
      map.setView([lat, lng], Math.max(map.getZoom(), ${FOLLOW_ZOOM}), { animate: true });
    }

    var now = Date.now();
    if (now - lastFetch > ${ROUTE_REFRESH_MS}) {
      lastFetch = now;
      fetchRoute(lat, lng);
    }
  };

  post({ type: 'ready' });
</script>
</body>
</html>`;

/**
 * Live GPS-to-destination tracking map, shown once a technician has
 * accepted a job. Fully interactive and rendered in-app: the technician
 * pans/zooms Leaflet directly (via WebView) and can follow their own
 * live position all the way to the job without switching to Google/Apple
 * Maps. A "Recenter" button snaps back to a driver's-eye follow view if
 * they've panned away to look around.
 *
 * `onOpenExternal` is kept as a small optional fallback link (e.g. for
 * turn-by-turn voice guidance, which this in-app map doesn't provide) —
 * it's no longer the only way to interact with the map.
 */
export default function LiveTrackingMap({
  destinationLatitude,
  destinationLongitude,
  destinationLabel,
  isOnline,
  onOpenExternal,
}: Props) {
  const webRef = useRef<WebView>(null);
  const [mapReady, setMapReady] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distanceKm: number; durationMin: number } | null>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        setLocationError("Location services are turned off on this device. Enable them in Settings to see live tracking.");
        return;
      }
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (status !== "granted") {
        setLocationError("Location permission was denied. Allow location access for PG Networks to see live tracking.");
        return;
      }
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 4000, distanceInterval: 10 },
        (position) => {
          if (cancelled) return;
          const { latitude, longitude } = position.coords;
          webRef.current?.injectJavaScript(
            `window.updateTechLocation && window.updateTechLocation(${latitude}, ${longitude}); true;`
          );
        }
      );
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
    // destination is fixed for the lifetime of this screen — only
    // isOnline toggling should restart the GPS watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "ready") setMapReady(true);
      if (data.type === "route") {
        setRouteInfo({ distanceKm: data.distanceKm, durationMin: data.durationMin });
      }
      if (data.type === "follow") {
        setFollowing(Boolean(data.following));
      }
    } catch {
      // Malformed/unexpected message — ignore, nothing in this component
      // depends on every message landing.
    }
  };

  const handleRecenter = () => {
    webRef.current?.injectJavaScript("window.recenterMap && window.recenterMap(); true;");
  };

  if (!isOnline) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          Live tracking needs a connection — use the saved address above to navigate for now.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.mapWrap}>
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          source={{ html: buildHtml(destinationLatitude, destinationLongitude) }}
          onMessage={handleMessage}
          style={styles.map}
          javaScriptEnabled
          domStorageEnabled
        />
        {!mapReady && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}
        {mapReady && !following && (
          <TouchableOpacity style={styles.recenterButton} onPress={handleRecenter} activeOpacity={0.85}>
            <Text style={styles.recenterButtonText}>Recenter</Text>
          </TouchableOpacity>
        )}
      </View>
      {locationError && <Text style={styles.error}>{locationError}</Text>}
      <View style={styles.footerRow}>
        {routeInfo ? (
          <Text style={styles.routeInfoText}>
            {routeInfo.distanceKm.toFixed(1)} km • ~{Math.max(1, Math.round(routeInfo.durationMin))} min to {destinationLabel}
          </Text>
        ) : (
          <View />
        )}
        <TouchableOpacity onPress={onOpenExternal}>
          <Text style={styles.externalLinkText}>Open in Maps ↗</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  mapWrap: { borderRadius: 12, overflow: "hidden", marginBottom: 8, height: 260, backgroundColor: colors.bg },
  map: { flex: 1, backgroundColor: "transparent" },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  recenterButton: {
    position: "absolute",
    bottom: 10,
    right: 10,
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  recenterButtonText: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  routeInfoText: { color: colors.textMuted, fontSize: 13, fontWeight: "600", flexShrink: 1, paddingRight: 8 },
  externalLinkText: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  error: { color: colors.danger, fontSize: 13, marginBottom: 6 },
  fallback: {
    backgroundColor: colors.cardAlt,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  fallbackText: { color: colors.textFaint, fontSize: 13, lineHeight: 18 },
});
