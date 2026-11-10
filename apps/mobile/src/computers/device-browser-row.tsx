import { deviceBrowser, deviceBrowserDetail } from "@opensteer/client/computers";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { MachineSummary } from "@opensteer/protocol";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, radius, space, touchTarget } from "../theme.js";
import { AppText, RowGroup } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/**
 * A device's browser, listed the way its apps are: what lives there, opening
 * the profiles. Nothing on a device that may not hold browsers.
 */
export function DeviceBrowserRow(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly machine: MachineSummary;
}): ReactNode {
  const navigation = useNavigation();
  const profiles = useHostSelector(props.hostClient, selectProfiles);
  const browser = deviceBrowser(props.machine, profiles);
  if (browser === null) return null;
  const detail = deviceBrowserDetail(browser);
  const body = (
    <>
      <View style={styles.mark}>
        <Symbol name="globe" size={16} tint={color.textSoft} />
      </View>
      <View style={styles.text}>
        <AppText role="body">Browser</AppText>
        <AppText role="secondary" tone="muted">
          {detail}
        </AppText>
      </View>
    </>
  );
  return (
    <RowGroup>
      {[
        browser.kind === "not-offered" ? (
          <View
            accessible
            accessibilityLabel={`Browser, ${detail}`}
            key="browser"
            style={styles.row}
          >
            {body}
          </View>
        ) : (
          <Pressable
            accessibilityLabel={`Browser, ${detail}`}
            accessibilityRole="button"
            key="browser"
            onPress={() =>
              navigation.navigate("BrowserProfiles", { deploymentId: props.deploymentId })
            }
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            {body}
            <Symbol name="chevron.right" size={13} tint={color.muted} />
          </Pressable>
        ),
      ]}
    </RowGroup>
  );
}

const selectProfiles = (snapshot: HostSnapshot) => snapshot.browserProfiles;

const styles = StyleSheet.create({
  mark: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderCurve: "continuous",
    borderRadius: radius.sm,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[16],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  text: { flex: 1, gap: space[2], minWidth: 0 },
});
