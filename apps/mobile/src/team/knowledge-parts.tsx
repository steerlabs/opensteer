import { unwrapRpcResult } from "@opensteer/client/host";
import type { TeamSessionClient } from "@opensteer/client/team";
import type { HostApiCommandInput } from "@opensteer/protocol";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, space } from "../theme.js";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { readLine, useScreenRead } from "../ui/client-feedback.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import { AppText } from "../ui/primitives.js";

/**
 * Read through the shared read owner, and again each time the screen comes
 * back into view or `reload` is called: knowledge has no live stream, so
 * coming back to a screen is the refresh. The last answer stays meanwhile.
 */
export function useFocusedRead<Value>(
  session: TeamSessionClient | null,
  read: (session: TeamSessionClient) => Promise<Value>,
  key: string,
  label: string,
): {
  readonly value: Value | null;
  readonly line: ActionLineValue | null;
  readonly reload: () => void;
} {
  const state = useScreenRead<Value>(session, {
    key: `knowledge:${label}:${key}`,
    label,
    read: session === null ? null : () => read(session),
  });
  const reload = state.refresh;
  useReloadOnReturn(reload);
  return { value: state.data, line: readLine(state, reload), reload };
}

/** Calls `reload` when the screen comes back into view, not on its first appearance. */
export function useReloadOnReturn(reload: () => void): void {
  const latest = useRef(reload);
  latest.current = reload;
  const seen = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (seen.current) latest.current();
      seen.current = true;
    }, []),
  );
}

export async function teamCommand(
  session: TeamSessionClient,
  input: HostApiCommandInput,
): Promise<void> {
  unwrapRpcResult(await session.rpc["commands.dispatch"](input));
}

export function useBottomPadding(): number {
  return useSafeAreaInsets().bottom + space[24];
}

export function viewerOf(session: TeamSessionClient | null): string {
  return session?.getSnapshot().bootstrap?.member.userId ?? "";
}

/** Content not here yet: still rows, or the one line saying it didn't load. */
export function Loading(props: { readonly line: ActionLineValue | null }): ReactNode {
  return (
    <View style={styles.center}>
      {props.line === null ? <PlaceholderRows count={5} /> : <ActionLine line={props.line} />}
    </View>
  );
}

export function Empty(props: { readonly text: string }): ReactNode {
  return (
    <View style={styles.empty}>
      <AppText role="secondary" style={styles.emptyText} tone="muted">
        {props.text}
      </AppText>
    </View>
  );
}

export function TextButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly accessibilityHint?: string;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="button"
      hitSlop={{ bottom: 12, left: 6, right: 6, top: 12 }}
      onPress={props.onPress}
    >
      <AppText role="secondaryMedium" tone="ember">
        {props.label}
      </AppText>
    </Pressable>
  );
}

export const knowledgeStyles = StyleSheet.create({
  actions: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  group: { gap: space[8] },
  page: { gap: space[16], padding: space[16] },
  pressed: { backgroundColor: color.surfacePressed },
  words: { flex: 1, gap: 1, minWidth: 0 },
});

const styles = StyleSheet.create({
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: space[16] },
  empty: { alignItems: "center", padding: space[32] },
  emptyText: { textAlign: "center" },
});
