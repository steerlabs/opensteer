import {
  cloudSuggestionDismissed,
  cloudSuggestionShown,
  cloudSuggestionStorageKey,
  cloudSuggestionVisible,
  cloudSuggestionWords,
  parseCloudSuggestionMemory,
  type CloudSuggestionMemory,
  type HomeKind,
} from "@opensteer/client/computers";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/**
 * What this phone remembers about the Cloud Computer suggestion: one record in its own
 * key-value store, read once and shared by every screen that may show the suggestion.
 */
type Memory =
  | { readonly loaded: false }
  | { readonly loaded: true; readonly value: CloudSuggestionMemory | null };
let memory: Memory = { loaded: false };
// Loaded only when a moment needs it, so a screen that never shows one never loads it.
const secureStore = () => import("expo-secure-store");
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Memory): void {
  memory = next;
  for (const listener of listeners) listener();
}

function read(): void {
  reading ??= secureStore()
    .then((store) => store.getItemAsync(cloudSuggestionStorageKey))
    .then((text) => publish({ loaded: true, value: parseCloudSuggestionMemory(text) }))
    .catch(() => publish({ loaded: true, value: null }));
}

function remember(value: CloudSuggestionMemory): void {
  publish({ loaded: true, value });
  void secureStore()
    .then((store) => store.setItemAsync(cloudSuggestionStorageKey, JSON.stringify(value)))
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  read();
  return () => listeners.delete(listener);
}
const snapshot = () => memory;

/** Forget what was read, so a test starts from the store again. */
export function resetCloudSuggestionForTests(): void {
  memory = { loaded: false };
  reading = null;
}

/**
 * Whether the suggestion shows for this moment, and its Not now. It shows only on a Mac Home,
 * only once the memory is read, and the first showing for a moment is remembered.
 */
export function useCloudSuggestion(input: {
  readonly homeKind: HomeKind | null;
  readonly moment: string;
  readonly now?: () => number;
}): { readonly visible: boolean; readonly notNow: () => void } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const now = input.now ?? Date.now;
  const visible =
    current.loaded &&
    cloudSuggestionVisible({
      homeKind: input.homeKind,
      memory: current.value,
      moment: input.moment,
      now: now(),
    });
  const value = current.loaded ? current.value : null;
  useEffect(() => {
    if (visible && value?.moment !== input.moment)
      remember(cloudSuggestionShown(value, input.moment, now()));
  }, [input.moment, now, value, visible]);
  return {
    visible,
    notNow: () => remember(cloudSuggestionDismissed(input.moment, now())),
  };
}

/**
 * The asleep moment: one quiet line and, when allowed, the Cloud Computer link and Not now.
 * `line` shows alone when `lineAlways`; otherwise the whole moment waits on the suggestion.
 */
export function AsleepMoment(props: {
  readonly line: string;
  readonly lineAlways: boolean;
  readonly homeKind: HomeKind | null;
  readonly moment: string;
  readonly onOpenCloudComputer: () => void;
  readonly centered?: boolean;
  readonly now?: () => number;
}): ReactNode {
  const suggestion = useCloudSuggestion({
    homeKind: props.homeKind,
    moment: props.moment,
    ...(props.now ? { now: props.now } : {}),
  });
  if (!props.lineAlways && !suggestion.visible) return null;
  const align = props.centered === true ? styles.centered : null;
  return (
    <View style={[styles.moment, props.centered === true ? styles.middle : null]}>
      <AppText role="secondary" style={align} tone="muted">
        {props.line}
      </AppText>
      {suggestion.visible ? (
        <View style={[styles.actions, props.centered === true ? styles.middle : null]}>
          <QuietLink
            label={cloudSuggestionWords.link}
            onPress={props.onOpenCloudComputer}
            tone="ember"
          />
          <QuietLink label={cloudSuggestionWords.notNow} onPress={suggestion.notNow} tone="muted" />
        </View>
      ) : null}
    </View>
  );
}

/** A link in a line of text: quiet, never a button that competes with the screen's own. */
function QuietLink(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly tone: "ember" | "muted";
}): ReactNode {
  return (
    <Pressable accessibilityRole="link" hitSlop={space[6]} onPress={props.onPress}>
      <AppText role="secondary" tone={props.tone}>
        {props.label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space[12] },
  centered: { textAlign: "center" },
  middle: { alignItems: "center", justifyContent: "center" },
  moment: { gap: space[4] },
});
