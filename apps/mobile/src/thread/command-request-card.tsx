import {
  commandApproval,
  commandApprovalRefusal,
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
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ScrollViewInstance,
} from "react-native";
import { color, material, radius, space } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { refusal as homeRefusal, useScreenAction } from "../ui/client-feedback.js";
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
  const identity = props.view.identity;
  // Every local fact of the card is this revision's own: a new one reads none of the last.
  const [result, setResult] = useState<{
    readonly identity: string;
    readonly outcome: CommandRequestOutcome;
  } | null>(null);
  const [armedFor, setArmedFor] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setArmedFor(identity), commandApproveArmMs);
    return () => clearTimeout(timer);
  }, [identity]);
  const armed = armedFor === identity;
  // The scroll surface keeps its measurements across revisions (its box and what is in it), and
  // a new revision starts at its top: a short one is seen at once, a long one must be scrolled.
  const scroller = useRef<ScrollViewInstance>(null);
  const [scroll, setScroll] = useState({ box: 0, content: 0, offset: 0 });
  const [seenFor, setSeenFor] = useState<string | null>(null);
  const atEnd = (box: number, content: number, offset: number) =>
    box > 0 && content > 0 && offset + box >= content - 2;
  useEffect(() => {
    scroller.current?.scrollTo({ y: 0, animated: false });
    setScroll((now) => {
      const reset = { ...now, offset: 0 };
      if (atEnd(reset.box, reset.content, 0)) setSeenFor(identity);
      return reset;
    });
  }, [identity]);
  const measured = (next: Partial<typeof scroll>) =>
    setScroll((now) => {
      const merged = { ...now, ...next };
      if (atEnd(merged.box, merged.content, merged.offset)) setSeenFor(identity);
      return merged;
    });
  const seen = seenFor === identity;
  const approve = useScreenAction(hostClient, `command-approve:${identity}`, {
    label: "approve it",
    done: "approved",
    happened: "your approval was sent",
    execute: async () => {
      try {
        const answered = (await hostClient.dispatch(commandApproval(request))) as {
          readonly outcome?: CommandRequestOutcome;
        };
        if (answered.outcome) setResult({ identity, outcome: answered.outcome });
        return answered;
      } catch (error) {
        // The Home's reason, where it says one: changed since it was read, or no longer asked.
        const refused = commandApprovalRefusal(error);
        if (refused) throw homeRefusal(refused.reason, refused.words);
        throw error;
      }
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
  const view =
    result?.identity === identity
      ? commandRequestView({
          ...request,
          status: "fulfilled",
          command: { ...request.command!, outcome: result.outcome },
        })!
      : props.view;
  const busy = props.disabled || approve.running || answer.running;
  const ready = armed && seen;
  const line = approve.line ?? answer.line;
  const screen = view.personOnly?.screen;
  const triggerId = (request.command?.command as { readonly triggerId?: unknown } | undefined)
    ?.triggerId;
  // An automation's Secrets are on that automation's own page.
  const opens =
    screen?.id === "automation-secrets" && typeof triggerId === "string"
      ? { route: "Schedule", params: { deploymentId: props.deploymentId, triggerId } }
      : screen && screenRoutes[screen.id]
        ? { route: screenRoutes[screen.id]!, params: { deploymentId: props.deploymentId } }
        : null;
  const approveHint = [
    !seen ? commandRequestWords.more : null,
    !armed ? commandRequestWords.arming : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <View
      accessibilityLabel={view.sentence}
      style={[styles.card, props.highlighted === true && styles.highlighted]}
    >
      <AppText role="secondaryMedium">{view.sentence}</AppText>
      <AppText role="caption" tone="soft">
        {view.askedBy}
      </AppText>
      <ScrollView
        accessibilityLabel={view.rowsHeading}
        bounces={false}
        onContentSizeChange={(_, content) => measured({ content })}
        onLayout={(event) => measured({ box: event.nativeEvent.layout.height })}
        onScroll={(event) => measured({ offset: event.nativeEvent.contentOffset.y })}
        ref={scroller}
        scrollEventThrottle={32}
        style={{ maxHeight: Math.max(160, Math.min(height * 0.4, 360)) }}
        testID="command-rows"
      >
        <View style={styles.rows}>
          {view.gives ? (
            <AppText role="caption" tone="soft">
              {view.gives}
            </AppText>
          ) : null}
          {view.personOnly ? (
            <AppText role="caption" tone="soft">
              {`${commandRequestWords.needs}: ${view.personOnly.needs}`}
            </AppText>
          ) : null}
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
          <AppText role="caption" tone="soft">
            {view.rowsHeading}
          </AppText>
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
              {row.meaning ? (
                <AppText role="caption" tone="soft">
                  {row.meaning}
                </AppText>
              ) : null}
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
      {view.approve && !seen ? (
        <AppText role="caption" tone="soft">
          {commandRequestWords.more}
        </AppText>
      ) : null}
      {view.approve && !armed ? (
        <AppText role="caption" tone="soft">
          {commandRequestWords.arming}
        </AppText>
      ) : null}
      <AppText role="caption" tone="muted">
        {view.line}
      </AppText>
      {screen && opens ? (
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
                )(opens.route, opens.params);
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
              {...(approveHint ? { accessibilityHint: approveHint } : {})}
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
