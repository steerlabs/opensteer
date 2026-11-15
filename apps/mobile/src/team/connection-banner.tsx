import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import type { TeamSessionSnapshot } from "@opensteer/client/team";
import type { MobileTeam } from "./mobile-teams.js";
import type { ConnectionBannerView } from "./team-models.js";

/**
 * One line under the bar when a team, or the reader's own Opensteer, can't be
 * reached right now. Never a modal: what is loaded stays readable under it,
 * and sends wait in order. The parent shows it only after two seconds, so a
 * blip draws nothing.
 */
export function ConnectionBanner(props: { readonly banner: ConnectionBannerView }): ReactNode {
  const { banner } = props;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.banner,
        banner.tone === "danger" ? styles.danger : banner.tone === "amber" ? styles.amber : null,
      ]}
    >
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={2}
        role="caption"
        style={[
          styles.text,
          banner.tone === "danger"
            ? styles.textDanger
            : banner.tone === "amber"
              ? styles.textAmber
              : null,
        ]}
      >
        {banner.text}
      </AppText>
      {banner.action === null ? null : (
        <Pressable
          accessibilityRole="button"
          hitSlop={{ bottom: 10, top: 10 }}
          onPress={banner.action.onPress}
          style={styles.action}
        >
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="caption"
            style={styles.actionLabel}
          >
            {banner.action.label}
          </AppText>
        </Pressable>
      )}
    </View>
  );
}

/**
 * One line per team, shown only once a reconnect has taken two seconds. Never a modal.
 * "Can't reach" waits for the session's own deadline, so a server swap reads as nothing.
 */
export function useConnectionBanner(
  team: MobileTeam | null,
  snapshot: Pick<TeamSessionSnapshot, "connection" | "unreachable" | "versionRefusal">,
  retry: () => void,
): ConnectionBannerView | null {
  const connected = snapshot.connection === "connected";
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (connected) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), 2_000);
    return () => clearTimeout(timer);
  }, [connected]);
  const name = team?.name ?? "the team";
  const update = snapshot.versionRefusal ?? team?.state;
  if (update === "update-app")
    return { text: `Update Opensteer to keep using ${name}`, tone: "amber", action: null };
  if (update === "update-server")
    return { text: `${name}'s server needs an update`, tone: "amber", action: null };
  if (connected) return null;
  if (snapshot.unreachable)
    return {
      text: `Can't reach ${name}`,
      tone: "danger",
      action: { label: "Try again", onPress: retry },
    };
  return late ? { text: `Reconnecting to ${name}…`, tone: "muted", action: null } : null;
}

const styles = StyleSheet.create({
  action: { justifyContent: "center", minHeight: touchTarget - 12 },
  actionLabel: { color: color.ember, fontWeight: "700" },
  amber: { backgroundColor: color.amberWash, borderColor: color.amberLine },
  banner: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    flexDirection: "row",
    gap: space[12],
    minHeight: 36,
    paddingHorizontal: space[16],
    paddingVertical: space[6],
  },
  danger: { backgroundColor: color.redWash, borderColor: color.redLine },
  text: { color: color.textSoft, flex: 1 },
  textAmber: { color: color.amber },
  textDanger: { color: color.red },
});
