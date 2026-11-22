import {
  deriveSurface,
  mutationIdempotencyKey,
  requestDecision,
  canRespondToRequests,
  sessionQuestions,
  workWords,
  type HostClient,
  type HostSnapshot,
  type OperationRow,
  type OperationRequestView,
  type SessionTaskView,
} from "@opensteer/client/host";
import { useStackedLayout } from "../ui/stacked-layout.js";
import { useThreadAgentPlace, useThreadTranscript } from "@opensteer/client/react";
import { useHeaderHeight } from "@react-navigation/elements";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ExternalAgentMark } from "../screens/external-agent-mark.js";
import { useShowTab } from "../tabs/viewer-open.js";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { useContentInsets } from "../ui/pane.js";
import { useGutter } from "../ui/screen.js";
import { useScreenAction } from "../ui/client-feedback.js";
import { ComposerAction } from "../ui/composer-action.js";
import { useHostValue, useMobileClient } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { operationRequestsOf, type OperationRequestItem } from "./agent-session-model.js";
import { useAgentSessionStop, useSessionThread } from "./agent-session-hooks.js";

export { useSessionRow, useSessionTask } from "./agent-session-hooks.js";
import type { ThreadHeaderState } from "./thread-pane.js";
import { RequestPageLink } from "./request-page-link.js";
import { QuestionCard } from "./waiting-questions.js";

const selectUser = (snapshot: HostSnapshot) => snapshot.user;

/**
 * A task a connected agent works itself: its activity as it happens, the page or app it is
 * using now, the Requests it opened (a direct operation's Allow once, and whatever it asked
 * the person itself, with that question's own choices), and where the composer would be,
 * the agent's state with Stop. Nobody types into another agent's task.
 */
export function AgentSessionPane(props: {
  readonly deploymentId: string;
  /**
   * Points at the top of the pane covered by a floating header, as a conversation takes it.
   * Left out, the screen's own navigation bar decides.
   */
  readonly headerClearance?: number | undefined;
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly title: string;
  readonly view: SessionTaskView;
  readonly onHeader?: ((header: ThreadHeaderState) => void) | undefined;
}): ReactNode {
  const { hostClient, onHeader, threadId, title, view } = props;
  // The pane runs under the bar's floating title and beside whatever stands at its sides (a
  // notch, iPhone Duo's vertical bar with the bar's controls in it, a reserved region), as a
  // conversation does: its content starts below the one and keeps off the others.
  const gutter = useGutter();
  const insets = useContentInsets();
  const headerHeight = useHeaderHeight();
  const top = props.headerClearance ?? headerHeight;
  const sides = { paddingLeft: gutter + insets.left, paddingRight: gutter + insets.right };
  useEffect(() => {
    onHeader?.({
      connectionLabel: view.header,
      title,
      icon: null,
      color: null,
      isVoice: false,
      task: null,
    });
  }, [onHeader, title, view.header]);
  const transcript = useThreadTranscript(hostClient, threadId);
  const thread = useSessionThread(hostClient, threadId);
  const requests = useMemo(
    () => operationRequestsOf({ threads: thread ? [thread] : [] }, threadId, transcript.requests),
    [thread, threadId, transcript.requests],
  );
  const questions = useMemo(() => sessionQuestions(transcript.requests), [transcript.requests]);
  const user = useHostValue(hostClient, selectUser, null);
  const canRespond = useHostValue(hostClient, canRespondToRequests, false);
  // Where the agent works now, and the page its questions are about: the task's own tabs.
  const place = useThreadAgentPlace(hostClient, threadId);
  const drafts = useMobileClient().drafts;
  const showTab = useShowTab(props.deploymentId, threadId);
  const stop = useAgentSessionStop(hostClient, threadId);
  const activity = view.activity;
  return (
    <View style={styles.pane} testID="agent-session">
      <ScrollView
        automaticallyAdjustsScrollIndicatorInsets={false}
        contentContainerStyle={[styles.content, sides, { paddingTop: top + space[12] }]}
        contentInsetAdjustmentBehavior="never"
        scrollIndicatorInsets={{ right: insets.right, top }}
      >
        {place === null || view.stop === null ? null : (
          <PlaceLink
            label={workWords("work.openPlace", { place: place.title })}
            onPress={() => showTab(place.tabId)}
            title={workWords("work.usingNow")}
          />
        )}
        {user === null
          ? null
          : questions.map((request) => {
              const surface = deriveSurface([request], user);
              return surface === null ? null : (
                <View
                  key={request.id}
                  style={styles.question}
                  testID={`session-question:${request.id}`}
                >
                  <RequestPageLink hostClient={hostClient} onOpen={showTab} request={request} />
                  <QuestionCard
                    canRespond={canRespond}
                    deploymentId={props.deploymentId}
                    drafts={drafts}
                    hostClient={hostClient}
                    surface={surface}
                    userId={user.id}
                  />
                </View>
              );
            })}
        <AppText role="secondaryMedium" tone="muted">
          {workWords("work.activity")}
        </AppText>
        {activity.kind === "unavailable" ? (
          <AppText tone="muted">{workWords("work.activityUnavailable")}</AppText>
        ) : activity.rows.length === 0 ? (
          <AppText tone="muted">{workWords("work.activityEmpty")}</AppText>
        ) : (
          activity.rows.map((row) => <OperationRowView key={row.id} row={row} />)
        )}
        {requests.map((item) => (
          <OperationRequestCard hostClient={hostClient} item={item} key={item.request.id} />
        ))}
      </ScrollView>
      <View
        style={[styles.bar, sides, { paddingBottom: space[12] + insets.bottom }]}
        testID="agent-session-footer"
      >
        <View style={styles.barRow}>
          <ExternalAgentMark
            initial={view.agent.initial}
            providerId={view.agent.providerId}
            size={24}
          />
          <View accessibilityLiveRegion="polite" style={styles.grow}>
            {/* The footer is the composer's place: its words stop growing where a control's
                do, and wrap rather than being cut, so the task above keeps its room. */}
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              role="secondaryMedium"
              tone={view.state === "stopped" || view.state === "ended" ? "muted" : "default"}
            >
              {view.statusLine}
            </AppText>
          </View>
          {view.stop === null ? null : (
            <ComposerAction
              busy={stop.running}
              disabled={false}
              kind="stop"
              label={view.stop.label}
              onPress={() => {
                if (view.stop) void stop.run(view.stop.sessionId);
              }}
            />
          )}
        </View>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
          {view.noComposer}
        </AppText>
        {stop.line === null ? null : <ActionLine line={stop.line} onDismiss={stop.dismiss} />}
      </View>
    </View>
  );
}

const glyphs: Readonly<Record<OperationRow["glyph"], SFSymbolName>> = {
  globe: "globe",
  app: "square.grid.2x2",
  plugin: "puzzlepiece.extension",
  list: "list.bullet",
};
const tones: Readonly<Record<OperationRow["outcome"]["tone"], string>> = {
  ok: color.green,
  bad: color.red,
  warn: color.amber,
  muted: color.muted,
  busy: color.textSoft,
};

/** One operation: what it did, who allowed it, and how it ended, stated plainly. */
export function OperationRowView({ row }: { readonly row: OperationRow }): ReactNode {
  const stacked = useStackedLayout();
  const glyph = <Symbol name={glyphs[row.glyph]} size={15} tint={color.textSoft} />;
  const words = (
    <View style={stacked ? undefined : styles.grow}>
      <AppText role="secondary">{row.action}</AppText>
      <AppText role="caption" tone="muted">
        {row.allowedBy === null ? row.outcome.label : `${row.allowedBy} · ${row.outcome.label}`}
      </AppText>
      {row.detail === null ? null : (
        <AppText role="caption" tone="muted">
          {row.detail}
        </AppText>
      )}
    </View>
  );
  const chip = (
    <View style={[styles.chip, { borderColor: tones[row.outcome.tone] }]}>
      <AppText role="caption" style={{ color: tones[row.outcome.tone] }}>
        {row.outcome.label}
      </AppText>
    </View>
  );
  // At an accessibility text size the mark and the outcome take the top line and the words the
  // full width under them: beside both, every word of a sentence broke inside itself.
  if (stacked)
    return (
      <View style={styles.operationStacked} testID={`operation:${row.id}`}>
        <View style={styles.operationTop}>
          {glyph}
          {chip}
        </View>
        {words}
      </View>
    );
  return (
    <View style={styles.operation} testID={`operation:${row.id}`}>
      {glyph}
      {words}
      {chip}
    </View>
  );
}

const answerSpec = {
  label: "send your answer",
  done: "sent",
  happened: "your answer was sent",
} as const;

/**
 * The Request a direct operation opened: the Home's question and summary, the agent's own
 * words kept apart and labelled, the exact calls behind one tap, and Allow once or Don't
 * allow. Once settled, only what happened.
 */
export function OperationRequestCard(props: {
  readonly hostClient: HostClient;
  readonly item: OperationRequestItem;
}): ReactNode {
  const { hostClient, item } = props;
  const { request, view } = item;
  const [showCalls, setShowCalls] = useState(false);
  const answer = useScreenAction<string, void>(hostClient, `request:${request.id}`, {
    ...answerSpec,
    execute: async (value) => {
      if (view.answers === null) return;
      await hostClient.dispatch({
        type: "request.respond",
        ...requestDecision(request),
        response: { kind: "form", answers: { [view.answers.fieldId]: [value] } },
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
      });
    },
  });
  return (
    <View style={styles.card} testID={`operation-request:${request.id}`}>
      <View style={styles.barRow}>
        <ExternalAgentMark
          initial={view.agent.initial}
          providerId={view.agent.providerId}
          size={20}
        />
        <AppText role="secondaryMedium" tone="muted">
          {view.agent.name}
        </AppText>
      </View>
      <AppText role="bodyMedium">{view.question}</AppText>
      {(view.context ?? view.summary) ? (
        <AppText role="secondary">{view.context ?? view.summary}</AppText>
      ) : null}
      {view.agentWords === null ? null : (
        <View style={styles.agentWords}>
          <AppText role="caption" tone="muted">
            {view.agentWords.label}
          </AppText>
          <AppText role="secondary" style={styles.italic} tone="soft">
            {view.agentWords.text}
          </AppText>
        </View>
      )}
      {view.calls === null ? null : (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowCalls((shown) => !shown)}
            style={styles.link}
          >
            <AppText role="secondaryMedium" tone="ember">
              {showCalls ? view.calls.hide : view.calls.show}
            </AppText>
          </Pressable>
          {showCalls ? (
            <AppText role="caption" style={styles.calls}>
              {view.calls.text}
            </AppText>
          ) : null}
        </>
      )}
      {view.answers === null ? (
        <AppText role="secondary" tone="muted">
          {view.settled}
        </AppText>
      ) : (
        <>
          <View style={styles.answers}>
            <AnswerButton
              busy={answer.running}
              label={view.answers.deny.label}
              onPress={() => void answer.run(view.answers!.deny.value)}
            />
            <AnswerButton
              busy={answer.running}
              label={view.answers.allow.label}
              onPress={() => void answer.run(view.answers!.allow.value)}
              primary
            />
          </View>
          <AppText role="caption" tone="muted">
            {view.after}
          </AppText>
        </>
      )}
      {answer.line === null ? null : <ActionLine line={answer.line} onDismiss={answer.dismiss} />}
    </View>
  );
}

/** Where the agent is working now, one tap from its task. */
function PlaceLink(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly title: string;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="link"
      onPress={props.onPress}
      style={styles.place}
    >
      <View style={styles.grow}>
        <AppText role="caption" tone="muted">
          {props.title}
        </AppText>
        {/* Its words wrap: a place cut to "Open Frida…" can't be told from another. */}
        <AppText role="secondaryMedium" tone="ember">
          {props.label}
        </AppText>
      </View>
      <Symbol name="chevron.right" size={13} tint={color.textSoft} />
    </Pressable>
  );
}

function AnswerButton(props: {
  readonly busy: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly primary?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy, disabled: props.busy }}
      disabled={props.busy}
      onPress={props.onPress}
      style={[styles.answer, props.primary === true && styles.primary]}
    >
      <AppText role="secondaryMedium" tone={props.primary === true ? "default" : "soft"}>
        {props.label}
      </AppText>
    </Pressable>
  );
}

/** The Needs you row's words and mark for a direct operation's Request. */
export type NeedsYouOperation = Pick<OperationRequestView, "agent" | "listTitle">;

const styles = StyleSheet.create({
  agentWords: {
    borderLeftColor: color.lineStrong,
    borderLeftWidth: 2,
    gap: space[4],
    paddingLeft: space[8],
  },
  answer: {
    alignItems: "center",
    borderColor: color.lineControl,
    borderRadius: radius.md,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: touchTarget,
  },
  answers: { flexDirection: "row", gap: space[8] },
  bar: {
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space[4],
    paddingTop: space[12],
  },
  barRow: { alignItems: "center", flexDirection: "row", gap: space[8] },
  calls: { backgroundColor: color.surfaceCode, fontFamily: "Menlo", padding: space[8] },
  card: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    gap: space[8],
    padding: space[12],
  },
  chip: {
    borderRadius: radius.xs,
    borderWidth: 1,
    paddingHorizontal: space[6],
    paddingVertical: 2,
  },
  content: { gap: space[12], paddingBottom: space[16] },
  grow: { flex: 1, minWidth: 0 },
  italic: { fontStyle: "italic" },
  link: { alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget },
  operation: { alignItems: "flex-start", flexDirection: "row", gap: space[8] },
  operationStacked: { gap: space[4] },
  operationTop: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  pane: { flex: 1 },
  place: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[12],
    paddingVertical: space[6],
  },
  question: { gap: space[4] },
  primary: { backgroundColor: color.emberWash, borderColor: color.emberLine },
});
