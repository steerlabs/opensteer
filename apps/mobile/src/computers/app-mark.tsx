import type { HostClient } from "@opensteer/client/host";
import { useAppIcon } from "@opensteer/client/react";
import type { ComputerAppIdentity } from "@opensteer/protocol";
import type { ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import { color, radius } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/**
 * A Mac app's mark: its initial on an icon-shaped tile, where the app's own
 * icon is not on the phone. It is decoration; whatever it sits beside names
 * the app.
 */
export function AppMark(props: {
  readonly blocked?: boolean | undefined;
  readonly name: string;
  readonly pending?: boolean;
  /** Its side, in points; the initial and the corners keep to it. */
  readonly size?: number;
}): ReactNode {
  const size = props.size ?? 32;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.mark,
        // The corners of a macOS icon, at any size.
        { borderRadius: Math.max(radius.xs, size * 0.225), height: size, width: size },
        props.pending === true && styles.pending,
        props.blocked === true && styles.blocked,
      ]}
    >
      {/* The tile is a fixed size, so its letter is too. */}
      <AppText
        maxFontSizeMultiplier={1}
        role="secondaryMedium"
        style={{ fontSize: Math.round(size * 0.46), lineHeight: Math.round(size * 0.6) }}
        tone="soft"
      >
        {props.name.trim().charAt(0).toUpperCase()}
      </AppText>
    </View>
  );
}

/**
 * The app's own icon, read once per app from the Mac it is on and kept for the
 * session; its initial stands in until then and wherever the Mac cannot say.
 * A macOS icon draws its own shape, so it is shown as it comes.
 */
export function MacAppIcon(props: {
  readonly app: ComputerAppIdentity;
  readonly blocked?: boolean;
  readonly hostClient: HostClient;
  readonly machineId: string;
  readonly size?: number;
}): ReactNode {
  const size = props.size ?? 32;
  const png = useAppIcon(props.hostClient, props.machineId, props.app);
  if (png === null)
    return <AppMark blocked={props.blocked} name={props.app.displayName} size={size} />;
  return (
    <Image
      accessibilityIgnoresInvertColors
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      source={{ uri: `data:image/png;base64,${png}` }}
      style={[{ height: size, width: size }, props.blocked === true && styles.blocked]}
    />
  );
}

const styles = StyleSheet.create({
  blocked: { opacity: 0.45 },
  mark: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    justifyContent: "center",
  },
  pending: {
    backgroundColor: "transparent",
    borderColor: color.lineStrong,
    borderStyle: "dashed",
    borderWidth: 1,
  },
});
