import { unwrapRpcResult } from "@opensteer/client/host";
import { noteWriterName, type TeamSessionClient } from "@opensteer/client/team";
import type { KnowledgeTopicId } from "@opensteer/core";
import type { HostApiCommandInput, TeamNotePreview } from "@opensteer/protocol";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, controlFontScaleLimit, material, radius, space } from "../theme.js";
import { AppText, Notice } from "../ui/primitives.js";
import { failureWords, noteWhen } from "./knowledge-model.js";

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

interface NotePages {
  readonly key: string;
  readonly words: string;
  readonly notes: readonly TeamNotePreview[];
  readonly cursor: string | null;
}

/**
 * Note previews, newest-changed first, or best matches for `query`. Bodies
 * are never listed: a note's text is read only when it is opened.
 */
export function useNotePages(
  session: TeamSessionClient | null,
  input: { readonly topicId?: KnowledgeTopicId; readonly query: string; readonly enabled: boolean },
): {
  readonly notes: readonly TeamNotePreview[] | null;
  /** The words the shown notes answer; typing ahead keeps the last answer on screen. */
  readonly answered: string;
  readonly more: boolean;
  readonly failure: string | null;
  readonly loadMore: () => void;
} {
  const words = input.query.trim();
  const key = `${input.topicId ?? ""}\n${words}`;
  const [pages, setPages] = useState<NotePages | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { enabled, topicId } = input;
  useFocusEffect(
    useCallback(() => {
      if (session === null || !enabled) return;
      let current = true;
      const timer = setTimeout(
        () =>
          void session.rpc["team.knowledge.notes.page"]({
            ...(topicId === undefined ? {} : { topicId }),
            ...(words === "" ? {} : { query: words }),
          })
            .then(unwrapRpcResult)
            .then(
              (page) => {
                if (!current) return;
                setPages({ key, words, notes: page.notes, cursor: page.nextCursor });
                setFailure(null);
              },
              (error: unknown) =>
                current && setFailure(failureWords(error, "The team didn't answer.")),
            ),
        // Typing settles before the team is asked.
        words === "" ? 0 : 250,
      );
      return () => {
        current = false;
        clearTimeout(timer);
      };
    }, [enabled, key, session, topicId, words]),
  );
  const loadMore = (): void => {
    if (session === null || pages === null || pages.cursor === null || loadingMore) return;
    const held = { key: pages.key, cursor: pages.cursor };
    setLoadingMore(true);
    void session.rpc["team.knowledge.notes.page"]({
      ...(topicId === undefined ? {} : { topicId }),
      ...(words === "" ? {} : { query: words }),
      cursor: held.cursor,
    })
      .then(unwrapRpcResult)
      .then(
        (page) =>
          setPages((now) =>
            now?.key === held.key
              ? { ...now, notes: [...now.notes, ...page.notes], cursor: page.nextCursor }
              : now,
          ),
        (error: unknown) => setFailure(failureWords(error, "The team didn't answer.")),
      )
      .finally(() => setLoadingMore(false));
  };
  const fresh = pages?.key === key ? pages : null;
  return {
    notes: pages?.notes ?? null,
    answered: pages?.words ?? "",
    more: fresh?.cursor != null,
    failure,
    loadMore,
  };
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

/** One note in a list: its title, the start of its text, who wrote it and when. */
export function NoteCard(props: {
  readonly note: TeamNotePreview;
  readonly viewerId: string;
  readonly now: Date;
  /** The topic it is in, where a list spans topics. */
  readonly topicName?: string | null;
  readonly onOpen: () => void;
}): ReactNode {
  const { note } = props;
  const who = noteWriterName(note.writer, props.viewerId);
  const when = noteWhen(note.writtenAt, props.now);
  const foot = [props.topicName ?? null, who, when].filter((part) => part !== null).join(" · ");
  return (
    <Pressable
      accessibilityHint="Opens the note"
      accessibilityLabel={`${note.title}. ${foot}`}
      accessibilityRole="button"
      onPress={props.onOpen}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <AppText numberOfLines={2} role="title">
        {note.title}
      </AppText>
      {note.preview.trim() === "" ? null : (
        <AppText numberOfLines={2} role="secondary" tone="soft">
          {note.preview}
        </AppText>
      )}
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        tone="muted"
      >
        {foot}
      </AppText>
    </Pressable>
  );
}

/** Previews as cards, with the way to the next page and the right empty words. */
export function NoteList(props: {
  readonly notes: readonly TeamNotePreview[] | null;
  readonly failure: string | null;
  readonly more: boolean;
  readonly onMore: () => void;
  readonly query: string;
  readonly emptyText: string;
  readonly viewerId: string;
  readonly topicName?: (topicId: string) => string | null;
  readonly onOpen: (note: TeamNotePreview) => void;
}): ReactNode {
  const now = new Date();
  if (props.notes === null)
    return props.failure === null ? (
      <View style={styles.searching}>
        <ActivityIndicator accessibilityLabel="Loading notes" color={color.muted} />
      </View>
    ) : (
      <Notice detail={props.failure} title="Notes didn't load" tone="neutral" />
    );
  const words = props.query.trim();
  if (props.notes.length === 0)
    return <Empty text={words === "" ? props.emptyText : `No notes match “${words}”.`} />;
  return (
    <View style={styles.notes}>
      {props.notes.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          now={now}
          onOpen={() => props.onOpen(note)}
          topicName={props.topicName?.(note.topicId) ?? null}
          viewerId={props.viewerId}
        />
      ))}
      {props.more ? (
        <View style={styles.more}>
          <TextButton label="Show more" onPress={props.onMore} />
        </View>
      ) : null}
    </View>
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
  card: { ...material.plate, borderRadius: radius.lg, gap: space[4], padding: space[14] },
  cardPressed: { ...material.platePressed },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: space[16] },
  empty: { alignItems: "center", padding: space[32] },
  emptyText: { textAlign: "center" },
  more: { alignItems: "center", paddingVertical: space[8] },
  notes: { gap: space[10] },
  searching: { alignItems: "center", padding: space[24] },
});
