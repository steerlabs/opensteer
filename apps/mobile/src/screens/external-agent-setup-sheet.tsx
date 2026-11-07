import type { ExternalAgentGuide, guideAddress } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, radius, space } from "../theme.js";
import { useCopy } from "../ui/copy-mark.js";
import { AppText, monoFontFamily, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { Symbol } from "../ui/symbol.js";
import { ExternalAgentMark } from "./external-agent-mark.js";

/**
 * How to add one agent: three plain steps. The only thing that changes while
 * it is open is the end — the new connection, once the person has approved it.
 */
export function ExternalAgentSetupSheet(props: {
  readonly guide: ExternalAgentGuide | null;
  /** Null while the address is still being read. */
  readonly address: ReturnType<typeof guideAddress> | null;
  /** The connection this sheet was waiting for, once it exists. */
  readonly connected: { readonly label: string } | null;
  readonly onClose: () => void;
  readonly onRemoteAccess: () => void;
}): ReactNode {
  const guide = props.guide;
  return (
    <Sheet open={guide !== null} onClose={props.onClose} title={guide ? `Add ${guide.name}` : ""}>
      {guide === null ? null : (
        <View style={styles.body}>
          <View style={styles.hero}>
            <ExternalAgentMark providerId={guide.providerId} size={56} />
            <AppText role="secondary" tone="muted" style={styles.center}>
              {guide.summary}
            </AppText>
          </View>
          {props.connected === null ? (
            <>
              <Step number={1} title="Copy this address">
                <AddressStep address={props.address} onRemoteAccess={props.onRemoteAccess} />
              </Step>
              <Step number={2} title={guide.step} />
              <Step
                number={3}
                title={`Approve the request in Opensteer when ${guide.name} asks.`}
              />
            </>
          ) : (
            <View accessibilityLiveRegion="polite" style={styles.done}>
              <Symbol name="checkmark.circle.fill" size={40} tint={color.green} />
              <AppText role="title" style={styles.center}>
                {`${props.connected.label} is connected.`}
              </AppText>
              <PrimaryButton label="Done" onPress={props.onClose} />
            </View>
          )}
        </View>
      )}
    </Sheet>
  );
}

function Step(props: {
  readonly children?: ReactNode;
  readonly number: number;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.step}>
      <View accessibilityElementsHidden importantForAccessibility="no" style={styles.number}>
        <AppText role="secondaryMedium" tone="soft">
          {String(props.number)}
        </AppText>
      </View>
      <View style={styles.stepBody}>
        <AppText accessibilityLabel={`Step ${props.number}. ${props.title}`} role="body">
          {props.title}
        </AppText>
        {props.children}
      </View>
    </View>
  );
}

function AddressStep(props: {
  readonly address: ReturnType<typeof guideAddress> | null;
  readonly onRemoteAccess: () => void;
}): ReactNode {
  const { copied, copy } = useCopy();
  const address = props.address;
  if (address === null)
    return (
      <AppText role="secondary" tone="muted">
        Finding your address…
      </AppText>
    );
  if (address.kind === "blocked")
    return (
      <View style={styles.blocked}>
        <AppText role="secondary" tone="soft">
          {address.detail}
        </AppText>
        <SecondaryButton compact label="Open Remote access" onPress={props.onRemoteAccess} />
      </View>
    );
  return (
    <View style={styles.address}>
      <AppText selectable role="caption" style={styles.url}>
        {address.url}
      </AppText>
      <Pressable
        accessibilityLabel={copied ? "Copied" : "Copy address"}
        accessibilityRole="button"
        hitSlop={space[8]}
        onPress={() => copy(address.url)}
        style={({ pressed }) => [styles.copy, pressed && styles.copyPressed]}
      >
        <AppText role="secondaryMedium" tone="ember">
          {copied ? "Copied" : "Copy"}
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  address: {
    alignItems: "center",
    backgroundColor: color.surfaceCode,
    borderColor: color.lineStrong,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[12],
    paddingLeft: space[12],
    paddingVertical: space[4],
  },
  blocked: { alignItems: "flex-start", gap: space[10] },
  body: { gap: space[24], paddingHorizontal: space[20], paddingTop: space[12] },
  center: { textAlign: "center" },
  copy: { borderRadius: radius.xs, paddingHorizontal: space[12], paddingVertical: space[8] },
  copyPressed: { backgroundColor: color.surfacePressed },
  done: { alignItems: "center", gap: space[16], paddingTop: space[8] },
  hero: { alignItems: "center", gap: space[12] },
  number: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  step: { flexDirection: "row", gap: space[14] },
  stepBody: { flex: 1, gap: space[10], paddingTop: space[2] },
  url: { color: color.text, flex: 1, fontFamily: monoFontFamily },
});
