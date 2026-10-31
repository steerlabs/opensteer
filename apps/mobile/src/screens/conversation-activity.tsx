import {
  canRespondToRequests,
  conversationActivityTurn,
  formatClockTime,
  groupTranscriptEntries,
  visibleTranscript,
  withoutOwnAssignment,
  type HostClient,
  type SurfaceDestination,
} from "@opensteer/client/host";
import { useHostSnapshot, useThreadInputQueue } from "@opensteer/client/react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { surfaceRoute } from "../browser/surface-route.js";
import { color, space } from "../theme.js";
import { AttachmentReader } from "../thread/attachment-views.js";
import {
  ReplySurfaces,
  TranscriptSurfacesContext,
  type TranscriptSurfaces,
} from "../thread/surface-chips.js";
import { ConversationSteps } from "../thread/transcript.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice } from "../ui/primitives.js";
import { useContentInsets } from "../ui/pane.js";
import { useGutter } from "../ui/screen.js";

export type ConversationActivityScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly threadId: string;
  /** The reply to show, by its turn's key. Absent, the reply under way or else the latest. */
  readonly turnKey?: string | undefined;
  readonly messageId?: string | undefined;
}>;

/**
 * Run details: what one of Opensteer's replies did on the way to it, opened
 * on purpose from the reply's menu or the reply under way, with the pages and
 * apps it used.
 *
 * It reads the reply from the live transcript rather than taking its steps as
 * a route parameter, so a reply still being written keeps adding to it here.
 */
export function ConversationActivityScreen(props: ConversationActivityScreenProps): ReactNode {
  const { deploymentId, threadId, turnKey } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return <Unavailable detail="This deployment is no longer open." />;
  }
  return (
    <ReplyActivity
      messageId={props.route.params.messageId ?? null}
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      threadId={threadId}
      turnKey={turnKey ?? null}
    />
  );
}

function ReplyActivity(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly turnKey: string | null;
  readonly messageId: string | null;
}): ReactNode {
  const { deploymentId, hostClient, threadId, turnKey } = props;
  const navigation = useNavigation();
  const { snapshot } = useHostSnapshot(hostClient);
  const queue = useThreadInputQueue(hostClient, threadId);
  const thread = snapshot.threads.find(({ id }) => id === threadId) ?? null;
  const entries = snapshot.transcripts[threadId];
  const inputQueuePaused = thread?.inputQueuePaused ?? false;
  // The conversation's own turns, so a key its rows hand over finds its reply.
  const groups = useMemo(
    () =>
      groupTranscriptEntries(
        withoutOwnAssignment(
          visibleTranscript(entries ?? [], queue, { conversation: true }),
          threadId,
        ),
        { inputQueuePaused },
      ),
    [entries, inputQueuePaused, queue, threadId],
  );
  const activity = useMemo(
    () =>
      conversationActivityTurn(
        groups,
        turnKey === null ? { kind: "latest" } : { key: turnKey, kind: "turn" },
      ),
    [groups, turnKey],
  );
  const environment = snapshot.environments.find(({ id }) => id === thread?.environmentId);
  const live = canRespondToRequests(snapshot) && environment?.status === "connected";
  const openStep = useCallback(
    (entryId: string) => navigation.navigate("ThreadStep", { deploymentId, entryId, threadId }),
    [deploymentId, navigation, threadId],
  );
  // A page opens over the conversation, not inside this sheet: the sheet
  // closes first, so Back from the page returns to the conversation.
  const surfaces = useMemo<TranscriptSurfaces>(
    () => ({
      hostClient,
      open: (destination: SurfaceDestination) => {
        navigation.goBack();
        navigation.dispatch(
          StackActions.push("WorkspaceBrowser", surfaceRoute(deploymentId, threadId, destination)),
        );
      },
    }),
    [deploymentId, hostClient, navigation, threadId],
  );

  if (activity === null) {
    return turnKey === null ? (
      <Frame status={null}>
        <AppText role="secondary" tone="muted">
          Nothing yet.
        </AppText>
      </Frame>
    ) : (
      <Unavailable detail="That reply is no longer loaded. Open the conversation again to see it." />
    );
  }
  return (
    <AttachmentReader value={hostClient}>
      <Frame
        status={
          activity.live
            ? "Now"
            : activity.reply === null
              ? null
              : formatClockTime(activity.reply.createdAt)
        }
      >
        <TranscriptSurfacesContext.Provider value={surfaces}>
          <ReplySurfaces turn={activity.turn} turnKey={activity.key} />
        </TranscriptSurfacesContext.Provider>
        {activity.steps.length === 0 ? (
          <AppText role="secondary" tone="muted">
            {activity.live ? "Nothing yet." : "Opensteer answered without any steps."}
          </AppText>
        ) : (
          <ConversationSteps
            reveal={props.messageId}
            entries={activity.steps}
            highlightRequestId={null}
            live={live}
            onOpenStep={openStep}
            turn={activity.turn}
          />
        )}
      </Frame>
    </AttachmentReader>
  );
}

function Frame(props: { readonly children: ReactNode; readonly status: string | null }): ReactNode {
  const insets = useContentInsets();
  const gutter = useGutter();
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
        <AppText role="title">Run details</AppText>
        {props.status === null ? null : (
          <AppText role="caption" tone="muted">
            {props.status}
          </AppText>
        )}
      </View>
      {props.children}
    </ScrollView>
  );
}

function Unavailable(props: { readonly detail: string }): ReactNode {
  const navigation = useNavigation();
  return (
    <View style={[styles.sheet, styles.unavailable]}>
      <Notice
        action={{ label: "Close", onPress: () => navigation.goBack() }}
        detail={props.detail}
        title="These run details can't be shown"
        tone="neutral"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: space[16], paddingTop: space[24] },
  head: { gap: space[4] },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
  unavailable: { justifyContent: "center", padding: space[24] },
});
