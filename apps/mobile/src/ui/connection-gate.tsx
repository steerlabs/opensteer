import { memo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { color, space } from "../theme.js";
import { appear, dim, exit } from "./motion.js";
import { AppText, PrimaryButton, SecondaryButton } from "./primitives.js";
import { Symbol, type SFSymbolName } from "./symbol.js";

export type ConnectionGateSymbol = "offline" | "computer" | "signed-out" | "update";

const symbols: Record<ConnectionGateSymbol, SFSymbolName> = {
  computer: "desktopcomputer",
  offline: "icloud.slash",
  "signed-out": "person.crop.circle.badge.exclamationmark",
  update: "arrow.down.circle",
};

export interface ConnectionGateButton {
  readonly label: string;
  readonly onPress: () => void;
  /** Trying: the label stays and the button says it is busy. */
  readonly busy?: boolean;
}

/**
 * The one explanation while a screen has nothing usable to show. Connecting is
 * only a muted line; anything else has its symbol, title and a way on. It
 * waits a moment before it is seen, so a quick connect never flashes it, and a
 * change of state cross-fades its words without waiting again.
 */
export const ConnectionGate = memo(function ConnectionGate(props: {
  /** Changes only when the meaning changes; it keys the cross-fade. */
  readonly stateKey: string;
  /** Null for connecting: no symbol, title or buttons. */
  readonly symbol: ConnectionGateSymbol | null;
  readonly title: string | null;
  readonly detail: string;
  readonly primary?: ConnectionGateButton | null;
  readonly secondary?: ConnectionGateButton | null;
}): ReactNode {
  return (
    <Animated.View entering={dim} style={styles.gate}>
      <Animated.View
        accessibilityLiveRegion="polite"
        entering={appear}
        exiting={exit}
        key={props.stateKey}
        style={styles.state}
      >
        {props.symbol === null ? null : (
          <Symbol name={symbols[props.symbol]} size={32} tint={color.muted} />
        )}
        {props.title === null ? null : (
          <AppText role="title" style={styles.centered}>
            {props.title}
          </AppText>
        )}
        <AppText numberOfLines={2} role="secondary" style={styles.centered} tone="muted">
          {props.detail}
        </AppText>
        {props.primary || props.secondary ? (
          <View style={styles.actions}>
            {props.primary ? (
              <PrimaryButton
                busy={props.primary.busy === true}
                compact
                label={props.primary.label}
                onPress={props.primary.onPress}
                quietBusy
              />
            ) : null}
            {props.secondary ? (
              <SecondaryButton
                busy={props.secondary.busy === true}
                compact
                label={props.secondary.label}
                onPress={props.secondary.onPress}
              />
            ) : null}
          </View>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
});

/**
 * A screen behind its gate. While `gate` is set only the gate is drawn; when it
 * clears, the content mounts in that same frame under the gate, which fades
 * away over it, so there is never an empty state or a second swap between.
 */
export function Gated(props: { readonly children: ReactNode; readonly gate: ReactNode | null }) {
  return (
    <View style={styles.fill}>
      {props.gate === null ? props.children : null}
      {props.gate === null ? null : (
        <Animated.View exiting={exit} style={styles.cover}>
          {props.gate}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[12],
    justifyContent: "center",
    marginTop: space[8],
  },
  centered: { textAlign: "center" },
  cover: { ...StyleSheet.absoluteFill, backgroundColor: color.background },
  fill: { flex: 1 },
  gate: { flex: 1 },
  state: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    gap: space[8],
    justifyContent: "center",
    padding: space[24],
  },
});
