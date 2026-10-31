import { formatRelativeTime, messageAuthorName, type HostClient } from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import type { ThreadMessagePage } from "@opensteer/protocol";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, touchTarget, type } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { useListContentInsets } from "../ui/screen.js";
import { TextInput } from "../ui/text-input.js";

/** The Host's cap on a query; a longer one is refused, so it is not sent. */
const queryLimit = 256;

/** One canonical message, exactly as the Host's search returns it. */
type FoundMessage = ThreadMessagePage["messages"][number];

export type ThreadFindScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly threadId: string;
}>;

/**
 * Find in conversation.
 *
 * The query runs on the Host over this thread's own messages, and every result
 * is addressed by its exact source id. Opening one loads the messages around
 * it and leaves the reader there; it never guesses a position from text.
 */
export function ThreadFindScreen(props: ThreadFindScreenProps): ReactNode {
  const navigation = useNavigation();
  const { deploymentId, threadId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return (
      <View style={styles.centred}>
        <AppText role="secondary" tone="muted">
          This deployment is no longer open.
        </AppText>
        <SecondaryButton compact label="Done" onPress={() => navigation.goBack()} />
      </View>
    );
  }
  return (
    <ThreadFind deploymentId={deploymentId} hostClient={selection.hostClient} threadId={threadId} />
  );
}

function ThreadFind(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const navigation = useNavigation();
  const listInsets = useListContentInsets(space[24]);
  const { snapshot } = useHostSnapshot(props.hostClient);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly FoundMessage[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const opening = useRef(false);

  const search = useCallback(
    (before?: string): void => {
      const trimmed = query.trim();
      if (trimmed === "" || searching) return;
      setSearching(true);
      setFailure(null);
      void props.hostClient
        .searchThreadMessages({
          query: trimmed.slice(0, queryLimit),
          threadId: props.threadId,
          ...(before === undefined ? {} : { before }),
        })
        .then((page) => {
          setResults((current) =>
            before !== undefined && current !== null
              ? [...current, ...page.messages]
              : page.messages,
          );
          setNextBefore(page.window.nextBefore ?? null);
        })
        .catch((error: unknown) => {
          setFailure(operationDetail(error, "This conversation could not be searched."));
        })
        .finally(() => setSearching(false));
    },
    [props.hostClient, props.threadId, query, searching],
  );

  /**
   * Goes back to the conversation naming one exact source id.
   *
   * The pane owns the jump, as it does for a notification or a link: it is
   * what knows to hold the reader in the historical window it loads, and to
   * offer the way back to the live conversation.
   */
  const open = useCallback(
    (messageId: string): void => {
      if (opening.current) return;
      opening.current = true;
      // Back to the conversation this sheet was opened over, never a second
      // copy of it: Chat is the root route, a task the Thread beneath.
      navigation.dispatch(
        snapshot.homeThreadId === props.threadId
          ? StackActions.popTo("Home", { deploymentId: props.deploymentId, messageId })
          : StackActions.popTo("Thread", {
              deploymentId: props.deploymentId,
              messageId,
              threadId: props.threadId,
            }),
      );
    },
    [navigation, props.deploymentId, props.threadId, snapshot.homeThreadId],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<FoundMessage>) => (
      <Pressable
        accessibilityHint="Opens the conversation at this message"
        accessibilityRole="button"
        onPress={() => open(item.id)}
        style={({ pressed }) => [styles.result, pressed && styles.pressed]}
      >
        <View style={styles.resultHead}>
          <AppText role="secondaryMedium">
            {messageAuthorName(item.author, item.kind, snapshot.homeThreadId)}
          </AppText>
          <AppText role="caption" tone="muted">
            {formatRelativeTime(item.createdAt)}
          </AppText>
        </View>
        <AppText numberOfLines={3} role="secondary" tone="muted">
          {excerpt(item)}
        </AppText>
      </Pressable>
    ),
    [open, snapshot.homeThreadId],
  );

  return (
    <FlatList
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.content, listInsets]}
      data={results ?? []}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      keyExtractor={(item) => item.id}
      ListEmptyComponent={
        results === null ? (
          <AppText role="secondary" style={styles.hint} tone="muted">
            Search this conversation’s messages. A result opens the messages around it.
          </AppText>
        ) : (
          <AppText role="secondary" style={styles.hint} tone="muted">
            No matching messages.
          </AppText>
        )
      }
      ListFooterComponent={
        searching ? (
          <View style={styles.footer}>
            <ActivityIndicator color={color.muted} size="small" />
          </View>
        ) : nextBefore === null || results === null || results.length === 0 ? undefined : (
          <View style={styles.footer}>
            <SecondaryButton compact label="Older matches" onPress={() => search(nextBefore)} />
          </View>
        )
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.field}>
            <TextInput
              accessibilityLabel="Find in conversation"
              autoFocus
              maxLength={queryLimit}
              onChangeText={setQuery}
              onSubmitEditing={() => search()}
              placeholder="Find in conversation…"
              placeholderTextColor={color.mutedDim}
              returnKeyType="search"
              style={styles.input}
              value={query}
            />
          </View>
          {failure === null ? null : (
            <Notice detail={failure} title="Something did not work" tone="neutral" />
          )}
        </View>
      }
      renderItem={renderItem}
    />
  );
}

function excerpt(message: FoundMessage): string {
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text === "" ? "(attachment only)" : text;
}

const styles = StyleSheet.create({
  centred: { alignItems: "center", gap: space[12], padding: space[24] },
  content: { paddingHorizontal: space[16] },
  field: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
    justifyContent: "center",
  },
  footer: { alignItems: "center", paddingVertical: space[16] },
  header: { gap: space[10], paddingBottom: space[8], paddingTop: space[8] },
  hint: { paddingVertical: space[16] },
  input: { color: color.text, fontSize: type.secondary.fontSize, paddingVertical: space[8] },
  pressed: { backgroundColor: color.surface },
  result: {
    borderRadius: radius.md,
    gap: space[2],
    minHeight: touchTarget,
    paddingHorizontal: space[8],
    paddingVertical: space[10],
  },
  resultHead: { flexDirection: "row", gap: space[8], justifyContent: "space-between" },
});
