import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import type { BrowserSourceInspection } from "@opensteer/protocol/browser-sources";
import { useEffect, useState, type ReactNode } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { material, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/** How often a visible sign-in asks Chrome again. Inspecting reads no sign-in. */
const inspectEveryMs = 5_000;

/**
 * What every connected Chrome can do for one site, kept current while `active`.
 * It stops while the app is in the background: Chrome coming back is only news
 * to someone looking.
 */
export function useChromeInspection(
  hostClient: Pick<HostClient, "rpc">,
  url: string,
  active: boolean,
): { readonly error: string | null; readonly inspection: BrowserSourceInspection | null } {
  const [inspection, setInspection] = useState<BrowserSourceInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!active || !foreground) return;
    let live = true;
    const check = () => {
      void hostClient.rpc["browser.sources.inspect"]({ url })
        .then(unwrapRpcResult)
        .then((result) => {
          if (!live) return;
          setInspection(result);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (live) setError(operationDetail(reason, "Opensteer couldn’t check Chrome."));
        });
    };
    check();
    const timer = setInterval(check, inspectEveryMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, foreground, hostClient, url]);

  return { error, inspection };
}

/** One Chrome to use, read out as a radio with what it can do for the site. */
export function ChromeChoice(props: {
  readonly checked: boolean;
  readonly detail: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  const disabled = props.disabled === true;
  return (
    <Pressable
      accessibilityHint={props.detail}
      accessibilityLabel={props.label}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.checked, disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.choice,
        props.checked && styles.choiceChecked,
        disabled && styles.choiceDisabled,
        pressed && styles.pressed,
      ]}
    >
      <AppText role="bodyMedium">{props.label}</AppText>
      <AppText role="caption" tone="muted">
        {props.detail}
      </AppText>
    </Pressable>
  );
}

export function ChromeChoices(props: { readonly children: ReactNode }): ReactNode {
  return (
    <View accessibilityRole="radiogroup" style={styles.choices}>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  choice: {
    ...material.control,
    borderRadius: radius.sm,
    gap: space[2],
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[12],
    paddingVertical: space[8],
  },
  choiceChecked: { ...material.selected },
  choiceDisabled: { opacity: 0.5 },
  choices: { gap: space[8] },
  pressed: { ...material.platePressed, opacity: 0.68 },
});
