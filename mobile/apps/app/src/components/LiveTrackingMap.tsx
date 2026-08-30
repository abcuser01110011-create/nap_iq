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

/**
 * Builds the standalone HTML page rendered inside the WebView. Leaflet
 * itself (and its tiles) are fetched over the network, same tradeoff
 * JobLocationMap already makes for its native-maps preview — there's no
 * offline tile cache in this build, so this component is gated behind
 * `isOnline` by the caller.
 */
const buildHtml = (destLat: number, destLng: number) => `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; background: #0B1F3A; }
  .napiq-tech-dot {
    width: 16px; height: 16px; border-radius: 8px;
    background: #2E7DFF; border: 3px solid #FFFFFF;
    box-shadow: 0 0 0 5px rgba(46, 125, 255, 0.35);
  }
  .napiq-dest-pin {
    width: 14px; height: 14px; border-radius: 50% 50% 50% 0;
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
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    touchZoom: false,
    doubleClickZoom: false,
    scrollWheelZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false
  }).setView([DEST.lat, DEST.lng], 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  var destIcon = L.divIcon({ className: '', html: '<div class="napiq-dest-pin"></div>', iconSize: [14, 14] });
  var techIcon = L.divIcon({ className: '', html: '<div class="napiq-tech-dot"></div>', iconSize: [16, 16] });

  L.marker([DEST.lat, DEST.lng], { icon: destIcon }).addTo(map);

  var techMarker = null;
  var routeLine = null;
  var lastFetch = 0;

  function post(message) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function fitToRoute() {
    if (routeLine) {
      map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
    } else if (techMarker) {
      map.fitBounds(L.latLngBounds([techMarker.getLatLng(), [DEST.lat, DEST.lng]]), { padding: [30, 30] });
    }
  }

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
        fitToRoute();
        post({ type: 'route', distanceKm: route.distance / 1000, durationMin: route.duration / 60 });
      })
      .catch(function () {
        post({ type: 'error', message: 'Route unavailable' });
      });
  }

  window.updateTechLocation = function (lat, lng) {
    if (!techMarker) {
      techMarker = L.marker([lat, lng], { icon: techIcon }).addTo(map);
    } else {
      techMarker.setLatLng([lat, lng]);
    }
    var now = Date.now();
    if (now - lastFetch > ${ROUTE_REFRESH_MS}) {
      lastFetch = now;
      fetchRoute(lat, lng);
    } else {
      fitToRoute();
    }
  };

  post({ type: 'ready' });
</script>
</body>
</html>`;

/**
 * Live GPS-to-destination tracking map, shown once a technician has
 * accepted a job. Replaces the static JobLocationMap preview: this one
 * watches the device's real position (expo-location) and feeds it into a
 * Leaflet map (via WebView) that draws an actual driving route to the
 * job's coordinates, same routing engine the web dispatch board's
 * navigation card already uses.
 *
 * The map itself is non-interactive (pan/zoom disabled) so a tap always
 * hands off to the device's own Maps app for real turn-by-turn nav —
 * same "glanceable preview, tap to open externally" pattern as
 * JobLocationMap.
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
    } catch {
      // Malformed/unexpected message — ignore, nothing in this component
      // depends on every message landing.
    }
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
      <TouchableOpacity activeOpacity={0.9} onPress={onOpenExternal} style={styles.mapWrap}>
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
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>Open in Maps</Text>
        </View>
      </TouchableOpacity>
      {locationError && <Text style={styles.error}>{locationError}</Text>}
      {routeInfo && (
        <Text style={styles.routeInfoText}>
          {routeInfo.distanceKm.toFixed(1)} km • ~{Math.max(1, Math.round(routeInfo.durationMin))} min to {destinationLabel}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mapWrap: { borderRadius: 12, overflow: "hidden", marginBottom: 8, height: 200, backgroundColor: colors.bg },
  map: { flex: 1, backgroundColor: "transparent" },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  overlay: {
    position: "absolute",
    bottom: 8,
    right: 8,
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  overlayText: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  routeInfoText: { color: colors.textMuted, fontSize: 13, fontWeight: "600", marginBottom: 6 },
  error: { color: colors.danger, fontSize: 13, marginBottom: 6 },
  fallback: {
    backgroundColor: colors.cardAlt,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  fallbackText: { color: colors.textFaint, fontSize: 13, lineHeight: 18 },
});
