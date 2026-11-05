import { hostsDeployment } from "@opensteer/client/computers";
import {
  passwordsOfferLine,
  passwordsSuggestionKey,
  type HostSnapshot,
  type PasswordsSetupOffer,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, material, radius, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * The quiet offer of Opensteer Passwords after a sign-in found it lacking.
 * Passwords lives on the Mac, so the phone only says where; the Host wakes the
 * agent once the login exists.
 */
export function PasswordsSuggestion(props: {
  readonly deploymentId: string;
  readonly hostClient: Parameters<typeof useHostSelector>[0];
  readonly offer: PasswordsSetupOffer;
  readonly userId: string;
}): ReactNode {
  const homeName = useHostSelector(props.hostClient, selectHomeName);
  const dismissals = useMobileClient().usageNotices;
  const dismissed = useSyncExternalStore(
    dismissals.subscribe,
    dismissals.getSnapshot,
    dismissals.getSnapshot,
  );
  const key = passwordsSuggestionKey(props.deploymentId, props.userId);
  if (dismissed === null || dismissed.has(key)) return null;
  const line = passwordsOfferLine({
    card: props.offer.credential === "card",
    computer: homeName ?? "your Mac",
    need: props.offer.need,
    site: props.offer.site,
  });
  return (
    <View accessibilityLiveRegion="polite" style={styles.line}>
      <Symbol name="key" size={15} tint={color.ember} />
      <AppText role="caption" style={styles.words} tone="soft">
        {line.before}
        <AppText role="caption">{line.name}</AppText>
        {line.after}
      </AppText>
      <Pressable
        accessibilityLabel="Dismiss"
        accessibilityRole="button"
        onPress={() => dismissals.dismiss(key)}
        style={styles.dismiss}
      >
        <Symbol name="xmark" size={12} tint={color.mutedDim} />
      </Pressable>
    </View>
  );
}

function selectHomeName(snapshot: HostSnapshot): string | null {
  const kind = snapshot.deploymentShape?.kind ?? null;
  return snapshot.machines.find((machine) => hostsDeployment(machine, kind))?.name ?? null;
}

const styles = StyleSheet.create({
  dismiss: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    marginVertical: -space[8],
    width: touchTarget,
  },
  line: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[10],
    marginTop: space[10],
    paddingLeft: space[12],
    paddingVertical: space[8],
  },
  words: { flex: 1 },
});
