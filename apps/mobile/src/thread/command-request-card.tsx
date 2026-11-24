import {
  commandApproval,
  commandApproveArmMs,
  commandDecline,
  commandDoneMyself,
  commandRequestView,
  commandRequestWords,
  mutationIdempotencyKey,
  type CommandRequestView,
  type HostClient,
  type RequestView,
} from "@opensteer/client/host";
import type { CommandRequestOutcome } from "@opensteer/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { color, material, radius, space } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { useScreenAction } from "../ui/client-feedback.js";
import { AppText, monoFontFamily } from "../ui/primitives.js";
import { AnswerPill } from "./answer-pill.js";

/** Where each screen that performs a command is, in this app. */
const screenRoutes: Readonly<Record<string, string>> = {
  "account-link": "SettingsAccount",
  "add-device": "SettingsDevices",
  automation: "Schedules",
  "browser-profiles": "BrowserProfiles",
  chrome: "Chrome",
  "connected-agent": "SettingsExternalAgents",
  "device-access": "SettingsDevices",
  "device-apps": "SettingsDevices",
  plugin: "Plugins",
  "remote-access": "SettingsDevices",
};

/**
 * A command an agent proposed, all of it, as web shows it: the Home's sentence, who asked, every
 * argument whole with what the Home knows beside it, the agent's words kept as its own, then
 * Decline or Approve. The sentence and the buttons stay in view while the arguments scroll inside
 * the card; Approve waits until they were seen to their end and for a moment after the card
 * appears. After Approve it says what the command came to.
 */
export function CommandRequestCard(props: {
  readonly hostClient: HostClient;
  readonly deploymentId?: string;
  readonly request: RequestView;
  readonly view: CommandRequestView;
  readonly disabled: boolean;
  readonly highlighted?: boolean;
}): ReactNode {
  const { hostClient, request } = props;
  const { height } = useWindowDimensions();
  const [outcome, setOutcome] = useState<CommandRequestOutcome | null>(null);
  const shownRevision = `${request.id}:${request.reviewedRevision ?? ""}`;
  // One approval of this card as shown: a retry after a lost answer is the same approval.
  const approvalKey = useMemo(
    () => mutationIdempotencyKey(`command-approve:${shownRevision}`),
    [shownRevision],
  );
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), commandApproveArmMs);
    return () => clearTimeout(timer);
  }, [shownRevision]);
  const [scroll, setScroll] = useState({ box: 0, content: 0, offset: 0, seen: false });
  useEffect(() => setScroll({ box: 0, content: 0, offset: 0, seen: false }), [shownRevision]);
  const measured = (next: Partial<typeof scroll>) =>
    setScroll((now) => {
      const merged = { ...now, ...next };
      // Seen to the end only once both the box and what is in it were measured.
      const atEnd =
        merged.box > 0 && merged.content > 0 && merged.offset + merged.box >= merged.content - 2;
      return { ...merged, seen: merged.seen || atEnd };
    });
  const approve = useScreenAction(hostClient, `command-approve:${request.id}`, {
    label: "approve it",
    done: "approved",
    happened: "your approval was sent",
    execute: async () => {
      const result = (await hostClient.dispatch(commandApproval(request, approvalKey))) as {
        readonly outcome?: CommandRequestOutcome;
      };
      if (result.outcome) setOutcome(result.outcome);
      return result;
    },
  });
  const answer = useScreenAction(hostClient, `request:${request.id}`, {
    label: "send your answer",
    done: "sent",
    happened: "your answer was sent",
    execute: (done: boolean) =>
      hostClient.dispatch(
        (done ? commandDoneMyself : commandDecline)(
          request,
          mutationIdempotencyKey(`request:${request.id}`),
        ),
      ),
  });
  // What the approval came to, as soon as the Home answers it.
  const view = outcome
    ? commandRequestView({
        ...request,
        status: "fulfilled",
        command: { ...request.command!, outcome },
      })!
    : props.view;
  const busy = props.disabled || approve.running || answer.running;
  const ready = armed && scroll.seen;
  const line = approve.line ?? answer.line;
  const screen = view.personOnly?.screen;
  const route = screen ? (screenRoutes[screen.id] ?? "Settings") : null;
  return (
    <View
      accessibilityLabel={view.sentence}
      style={[styles.card, props.highlighted === true && styles.highlighted]}
    >
      <AppText role="secondaryMedium">{view.sentence}</AppText>
      <AppText role="caption" tone="soft">
        {view.askedBy}
      </AppText>
      {view.gives ? (
        <AppText role="caption" tone="soft">
          {view.gives}
        </AppText>
      ) : null}
      <AppText role="caption" tone="soft">
        {view.rowsHeading}
      </AppText>
      <ScrollView
        accessibilityLabel={view.rowsHeading}
        bounces={false}
        onContentSizeChange={(_, content) => measured({ content })}
        onLayout={(event) => measured({ box: event.nativeEvent.layout.height })}
        onScroll={(event) => measured({ offset: event.nativeEvent.contentOffset.y })}
        scrollEventThrottle={32}
        style={{ maxHeight: Math.max(160, Math.min(height * 0.32, 320)) }}
        testID="command-rows"
      >
        <View style={styles.rows}>
          {view.rows.map((row, index) => (
            <View
              key={`${index}:${row.path}`}
              style={[styles.row, { paddingLeft: row.depth * space[12] }]}
              testID={`command-row:${row.path}`}
            >
              <AppText role="caption" tone="muted">
                {row.label}
              </AppText>
              {row.value === null ? null : (
                <AppText role="caption" selectable style={{ fontFamily: monoFontFamily }}>
                  {row.value}
                </AppText>
              )}
              {row.name ? (
                <AppText role="caption" tone="soft">
                  {row.name}
                </AppText>
              ) : null}
              {row.current === null ? null : (
                <AppText role="caption" tone="muted" selectable>
                  {`${commandRequestWords.now}: ${row.current}`}
                </AppText>
              )}
            </View>
          ))}
        </View>
      </ScrollView>
      {scroll.seen ? null : (
        <AppText role="caption" tone="soft">
          {commandRequestWords.more}
        </AppText>
      )}
      {view.agentWords ? (
        <View style={styles.says}>
          <AppText role="caption" tone="muted">
            {view.agentWords.label}
          </AppText>
          <AppText role="caption" tone="soft">
            {view.agentWords.text}
          </AppText>
        </View>
      ) : null}
      <AppText role="caption" tone="muted">
        {view.line}
      </AppText>
      {screen && route ? (
        <AnswerPill
          label={`Open ${screen.label}`}
          onPress={() =>
            // Loaded when used: the card itself needs no navigator to show.
            void import("../navigation-ref.js").then(({ navigationRef }) => {
              if (navigationRef.isReady())
                (
                  navigationRef.navigate.bind(navigationRef) as (
                    name: string,
                    params: object,
                  ) => void
                )(route, { deploymentId: props.deploymentId });
            })
          }
          tone="secondary"
        />
      ) : null}
      {view.decline ? (
        <View style={styles.answers}>
          <AnswerPill
            disabled={busy}
            fill
            label={view.decline.label}
            onPress={() => void answer.run(false)}
            tone="secondary"
          />
          {view.doneMyself ? (
            <AnswerPill
              disabled={busy}
              fill
              label={view.doneMyself.label}
              onPress={() => void answer.run(true)}
              tone="secondary"
            />
          ) : null}
          {view.approve ? (
            <AnswerPill
              busy={approve.running}
              disabled={busy || !ready}
              fill
              label={view.approve.label}
              onPress={() => {
                if (ready) void approve.run(undefined);
              }}
              tone="primary"
            />
          ) : null}
        </View>
      ) : null}
      {line === null ? null : <ActionLine line={line} />}
    </View>
  );
}

const styles = StyleSheet.create({
  answers: { flexDirection: "row", gap: space[8] },
  card: {
    ...material.attention,
    borderRadius: radius.xxl,
    gap: space[8],
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  highlighted: { backgroundColor: material.selected.backgroundColor },
  row: { gap: space[2] },
  rows: { gap: space[6] },
  says: { borderLeftColor: color.muted, borderLeftWidth: 2, gap: space[2], paddingLeft: space[8] },
});
