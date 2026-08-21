import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import { colors } from "../theme/technician";

interface Props {
  latitude: number;
  longitude: number;
  label: string;
  isOnline: boolean;
  onOpenExternal: () => void;
}

/**
 * Map tiles have to be fetched live — there's no offline tile cache
 * in this build. Plan §3.2 calls that out as a deliberate scoping
 * choice ("full offline tile caching adds real complexity, worth
 * scoping separately") and offers the alternative taken here instead:
 * a graceful "map unavailable offline" fallback that leans on the
 * subscriber's address, already shown in the card above this one,
 * rather than trying to render tiles with no network.
 */
export default function JobLocationMap({ latitude, longitude, label, isOnline, onOpenExternal }: Props) {
  if (!isOnline) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          Map preview needs a connection — use the saved address above to navigate for now.
        </Text>
      </View>
    );
  }

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onOpenExternal} style={styles.mapWrap}>
      <MapView
        style={styles.map}
        pointerEvents="none"
        initialRegion={{
          latitude,
          longitude,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }}
      >
        <Marker coordinate={{ latitude, longitude }} title={label} />
      </MapView>
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
