import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { WebView } from "react-native-webview";
import { colors } from "../theme/technician";

interface Props {
  latitude: number;
  longitude: number;
  label: string;
  isOnline: boolean;
  onOpenExternal: () => void;
}

/**
 * Pin-location preview, built on Leaflet + OpenStreetMap tiles inside a
 * WebView instead of react-native-maps' Google-backed MapView (kept for
 * the general "Location" card above — see JobLocationMap.tsx). Only the
 * technician's own GPS pin uses this: it's a single-marker read-only
 * snapshot, so a lightweight HTML/JS map avoids pulling in the Google
 * Maps SDK just for this one card.
 *
 * Same offline fallback as JobLocationMap — tiles need a live network
 * fetch and there's no offline tile cache in this build, so an
 * unavailable-offline message leans on the address shown elsewhere on
 * the screen instead of trying to render a blank map.
 */
export default function PinLocationMap({ latitude, longitude, label, isOnline, onOpenExternal }: Props) {
  if (!isOnline) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          Map preview needs a connection — use the saved address above to navigate for now.
        </Text>
      </View>
    );
  }

  const escapedLabel = JSON.stringify(label);
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <style>
      html, body, #map { height: 100%; margin: 0; padding: 0; }
      .leaflet-control-attribution { font-size: 9px; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script>
      var map = L.map('map', {
        zoomControl: false,
        attributionControl: true,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false,
      }).setView([${latitude}, ${longitude}], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      L.marker([${latitude}, ${longitude}]).addTo(map).bindPopup(${escapedLabel});
    </script>
  </body>
</html>`;

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onOpenExternal} style={styles.mapWrap}>
      <WebView
        style={styles.map}
        originWhitelist={["*"]}
        source={{ html }}
        scrollEnabled={false}
        pointerEvents="none"
      />
      <View style={styles.overlay}>
        <Text style={styles.overlayText}>Open in Maps</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  mapWrap: { borderRadius: 12, overflow: "hidden", marginBottom: 14, height: 160 },
  map: { flex: 1 },
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
  fallback: {
    backgroundColor: colors.cardAlt,
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  fallbackText: { color: colors.textFaint, fontSize: 13, lineHeight: 18 },
});
