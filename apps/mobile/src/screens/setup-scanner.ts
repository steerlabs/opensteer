import { useCallback } from "react";
import { Alert, Linking } from "react-native";
import { routeSetupCode } from "../links.js";
import { scanQrCode } from "../platform/code-scanner.js";
import { useAppLinks } from "../ui/app-links-context.js";
import { useMobileClient } from "../ui/mobile-client-context.js";

/**
 * Scans the code a computer shows to connect this phone. A Connect code opens
 * that computer through the Account; a pairing code fills in the pairing form,
 * where the person confirms it. Anything the scanner cannot do ends at
 * entering the address instead.
 */
export function useSetupScanner(onAddress: () => void): () => void {
  const client = useMobileClient();
  const links = useAppLinks();
  const scan = useCallback((): void => {
    void scanQrCode()
      .catch(() => ({ kind: "unavailable" }) as const)
      .then((result) => {
        if (result.kind === "cancelled") return;
        if (result.kind === "scanned") {
          if (
            routeSetupCode(result.text, client.portalOrigin, {
              offer: links.offerPairing,
              open: links.openComputer,
            })
          ) {
            return;
          }
          Alert.alert(
            "This isn’t an Opensteer code.",
            "On your Mac, open Opensteer and choose Connect your phone, then scan the code it shows.",
            [
              { style: "cancel", text: "Cancel" },
              { onPress: scan, text: "Try Again" },
            ],
          );
          return;
        }
        if (result.kind === "camera-denied") {
          Alert.alert(
            "Camera access is off",
            "Allow Opensteer to use the camera in Settings, or enter your computer’s address instead.",
            [
              { style: "cancel", text: "Cancel" },
              { onPress: onAddress, text: "Enter Address" },
              { onPress: () => void Linking.openSettings(), text: "Open Settings" },
            ],
          );
          return;
        }
        Alert.alert(
          "Scanning isn’t available",
          "This phone can’t scan the code here. Enter your computer’s address instead.",
          [
            { style: "cancel", text: "Cancel" },
            { onPress: onAddress, text: "Enter Address" },
          ],
        );
      });
  }, [client, links, onAddress]);
  return scan;
}
