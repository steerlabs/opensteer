import {
  formatClockTime,
  messageRevisionRows,
  type HostClient,
  type MessageRevisionRow,
} from "@opensteer/client/host";
import type { MessageRevisionView } from "@opensteer/core";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { PlainProse } from "../markdown/markdown.js";
import { color, space, touchTarget } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice } from "../ui/primitives.js";
import { useContentInsets } from "../ui/pane.js";
import { useGutter } from "../ui/screen.js";

export type MessageHistoryScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly messageId: string;
  readonly threadId: string;
}>;

/**
 * Every version of a message a person edited while it waited, newest first:
 * for a teammate's ask, their words, then each of the person's edits. The
 * version a Run took is final, so this is the whole record of what was asked.
 */
export function MessageHistoryScreen(props: MessageHistoryScreenProps): ReactNode {
  const { deploymentId, messageId, threadId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null)
    return <Missing detail="This deployment is no longer open." />;
  return (
    <History
      hostClient={selection.hostClient}
      messageId={messageId}
      threadId={threadId}
      viewerUserId={selection.hostClient.getSnapshot().user?.id ?? null}
    />
  );
}

function History(props: {
  readonly hostClient: HostClient;
  readonly messageId: string;
  readonly threadId: string;
  readonly viewerUserId: string | null;
}): ReactNode {
  const { hostClient, messageId, threadId } = props;
  const insets = useContentInsets();
  const gutter = useGutter();
  const [revisions, setRevisions] = useState<readonly MessageRevisionView[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const load = useCallback(
    async (before?: number): Promise<void> => {
      setLoading(true);
      setFailure(null);
      try {
        const page = await hostClient.listMessageRevisions(threadId, messageId, before);
        if (!mounted.current) return;
        // Pages arrive newest first, each older than the last.
        setRevisions((held) =>
          before === undefined ? page.revisions : [...(held ?? []), ...page.revisions],
        );
        setHasMore(page.hasMore);
      } catch (error) {
        if (mounted.current)
          setFailure(operationDetail(error, "This message’s versions couldn’t be loaded."));
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [hostClient, messageId, threadId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const rows = revisions === null ? null : messageRevisionRows(revisions, props.viewerUserId);
  const oldest = revisions?.at(-1)?.revision;
  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        {
          paddingBottom: insets.bottom + space[24],
          paddingLeft: gutter + insets.left,
          paddingRight: gutter + insets.right,
        },
      ]}
      style={styles.sheet}
    >
      <View style={styles.head}>
        <AppText role="title">Edit history</AppText>
        <AppText role="caption" tone="muted">
          {rows === null
            ? "Loading…"
            : `${rows.length}${hasMore ? "+" : ""} ${rows.length === 1 ? "version" : "versions"}`}
        </AppText>
      </View>
      {rows === null && loading ? <ActivityIndicator color={color.muted} /> : null}
      {rows?.map((row, index) => (
        <View key={row.revision} style={[styles.row, index > 0 && styles.rowSeparated]}>
          <RevisionHead row={row} />
          <PlainProse text={row.text} />
          <RevisionParts content={row.content} />
        </View>
      ))}
      {failure === null ? null : (
        <View accessibilityRole="alert">
          <AppText role="caption" tone="danger">
            {failure}
          </AppText>
        </View>
      )}
      {hasMore || (failure !== null && rows !== null) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: loading, disabled: loading }}
          disabled={loading || oldest === undefined}
          onPress={() => void load(oldest)}
          style={styles.more}
        >
          {loading ? (
            <ActivityIndicator color={color.muted} />
          ) : (
            <AppText role="secondaryMedium" tone="ember">
              Earlier versions
            </AppText>
          )}
        </Pressable>
      ) : null}
      {failure !== null && rows === null ? (
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.more}>
          <AppText role="secondaryMedium" tone="ember">
            Try again
          </AppText>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

/** Who wrote this version, where and when, and whether it is the one waiting now. */
function RevisionHead(props: { readonly row: MessageRevisionRow }): ReactNode {
  const { row } = props;
  const facts = [row.by, row.device, formatClockTime(row.at)].filter(
    (fact): fact is string => fact !== null && fact !== "",
  );
  return (
    <View style={styles.revisionHead}>
      <AppText numberOfLines={1} role="caption" style={styles.facts} tone="muted">
        {facts.join(" · ")}
      </AppText>
      {row.current ? (
        <AppText role="caption" tone="ember">
          Current
        </AppText>
      ) : row.original ? (
        <AppText role="caption" tone="muted">
          Original
        </AppText>
      ) : null}
    </View>
  );
}

/** Files, pages and places this version carried, by name. */
function RevisionParts(props: { readonly content: MessageRevisionRow["content"] }): ReactNode {
  const names = props.content.flatMap((part) =>
    part.type === "text" ? [] : [part.type === "browser-page" ? part.title || part.url : part.name],
  );
  if (names.length === 0) return null;
  return (
    <AppText role="caption" tone="soft">
      {names.join(" · ")}
    </AppText>
  );
}

function Missing(props: { readonly detail: string }): ReactNode {
  const navigation = useNavigation();
  return (
    <View style={[styles.sheet, styles.missing]}>
      <Notice
        action={{ label: "Close", onPress: () => navigation.goBack() }}
        detail={props.detail}
        title="This history can't be shown"
        tone="neutral"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: space[16], paddingTop: space[24] },
  facts: { flexShrink: 1 },
  head: { gap: space[4] },
  missing: { justifyContent: "center", padding: space[24] },
  more: { alignItems: "center", justifyContent: "center", minHeight: touchTarget },
  revisionHead: { alignItems: "center", flexDirection: "row", gap: space[8] },
  row: { gap: space[6] },
  rowSeparated: {
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space[16],
  },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
});
