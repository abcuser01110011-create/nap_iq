import React, { useRef } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import SignatureScreen, { SignatureViewRef } from "react-native-signature-canvas";
import { colors } from "../theme/technician";

interface SignaturePadProps {
  visible: boolean;
  onCancel: () => void;
  /** base64 is the raw PNG data (no "data:image/png;base64," prefix
   * — that's already stripped before this fires) of what the
   * customer drew, on a plain white background so the same
   * server-side scan/cleanup step that used to run against a phone
   * photo of a signed printout (see _scan_signature_image() in
   * api_v1/technician.py) still applies here — no backend changes
   * needed, it just gets a cleaner "photo" to work from than a real
   * paper scan would. */
  onSave: (base64: string) => void;
}

// Forces a plain white canvas (not the library's default transparent
// background) so the backend's ink/background threshold step has a
// consistent, evenly-lit surface to work against — the same
// assumption that step was originally written for a photographed
// paper signature. Also forces html/body/pad/canvas-body to 100%
// width+height: the library's own default CSS only sizes the
// drawable canvas off a fixed initial layout pass, which on a tall
// full-screen container leaves the bottom portion visually white but
// not actually drawable — this override is what makes the whole box
// live.
const WEB_STYLE = `
  html, body { width: 100%; height: 100%; margin: 0; padding: 0; background-color: #FFFFFF; }
  .m-signature-pad { box-shadow: none; border: none; margin: 0; width: 100%; height: 100%; }
  .m-signature-pad--body { border: none; margin: 0; width: 100%; height: 100%; }
  .m-signature-pad--footer { display: none; margin: 0; }
`;

/** Full-screen "sign here" pad — the customer signs with a finger or
 * stylus directly on the device, replacing the old "photograph a
 * signed printout" flow. Kept as its own component (rather than
 * inlined in JobDetailScreen) since the signature-canvas library
 * needs its own WebView and ref plumbing that would otherwise
 * clutter that screen. */
export default function SignaturePad({ visible, onCancel, onSave }: SignaturePadProps) {
  const ref = useRef<SignatureViewRef>(null);

  const handleClear = () => {
    ref.current?.clearSignature();
  };

  const handleConfirm = () => {
    // readSignature() triggers the library's onOK handler below with
    // the base64 PNG — there's no direct return value here.
    ref.current?.readSignature();
  };

  const handleOK = (dataUrl: string) => {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    onSave(base64);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Customer sign-off</Text>
          <Text style={styles.subtitle}>Hand the device to the customer to sign below.</Text>
        </View>
        <View style={styles.padWrapper}>
          <SignatureScreen
            ref={ref}
            onOK={handleOK}
            webStyle={WEB_STYLE}
            backgroundColor="#FFFFFF"
            penColor="#000000"
            autoClear={false}
            trimWhitespace
          />
        </View>
        <View style={styles.footer}>
          <TouchableOpacity style={styles.secondaryButton} onPress={onCancel}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={handleClear}>
            <Text style={styles.secondaryButtonText}>Clear</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryButton} onPress={handleConfirm}>
            <Text style={styles.primaryButtonText}>Use this signature</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 48 },
  header: { paddingHorizontal: 20, marginBottom: 12 },
  title: { color: colors.text, fontSize: 20, fontWeight: "800" },
  subtitle: { color: colors.textFaint, fontSize: 13, marginTop: 4 },
  padWrapper: {
    flex: 1,
    marginHorizontal: 20,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: colors.border,
  },
  footer: {
    flexDirection: "row",
    gap: 10,
    padding: 20,
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryButtonText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
  primaryButton: {
    flex: 1.4,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
});
