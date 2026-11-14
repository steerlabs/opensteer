import { unwrapRpcResult } from "@opensteer/client/host";
import type { TeamSessionClient } from "@opensteer/client/team";
import type { HostApiCommandInput } from "@opensteer/protocol";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, space } from "../theme.js";
import { AppText, Notice } from "../ui/primitives.js";
import { failureWords } from "./knowledge-model.js";

/**
 * Reads once each time the screen comes into view, and again when `key`
 * changes or `reload` is called. The last answer stays on screen meanwhile:
 * knowledge has no live stream, so coming back to a screen is the refresh.
 */
export function useFocusedRead<Value>(
  session: TeamSessionClient | null,
  read: (session: TeamSessionClient) => Promise<Value>,
  key: string,
): {
  readonly value: Value | null;
  readonly failure: string | null;
  readonly reload: () => void;
} {
  const [answer, setAnswer] = useState<{
    session: TeamSessionClient;
    key: string;
    value: Value;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const reader = useRef(read);
  reader.current = read;
  useFocusEffect(
    useCallback(() => {
      if (session === null) return;
      let current = true;
      void reader.current(session).then(
        (next) => {
          if (!current) return;
          setAnswer({ session, key, value: next });
          setFailure(null);
        },
        (error: unknown) => current && setFailure(failureWords(error, "The team didn't answer.")),
      );
      return () => {
        current = false;
      };
    }, [session, key, generation]),
  );
  const reload = useCallback(() => setGeneration((next) => next + 1), []);
  return {
    value: answer?.session === session && answer.key === key ? answer.value : null,
    failure,
    reload,
  };
}

/**
 * Calls `reload` when the screen comes back into view, not on its first
 * appearance (the read is already under way then).
 */
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

export function Loading(props: { readonly failure: string | null }): ReactNode {
  return (
    <View style={styles.center}>
      {props.failure === null ? (
        <ActivityIndicator accessibilityLabel="Loading" color={color.muted} />
      ) : (
        <Notice detail={props.failure} title="This didn't load" tone="neutral" />
      )}
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
