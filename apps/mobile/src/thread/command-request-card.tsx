import {
  commandApproval,
  commandDecline,
  commandRequestView,
  commandRequestWords,
  mutationIdempotencyKey,
  type CommandRequestView,
  type HostClient,
  type RequestView,
} from "@opensteer/client/host";
import type { CommandRequestOutcome } from "@opensteer/core";
import { useState, type ReactNode } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { color, material, radius, space } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { useScreenAction } from "../ui/client-feedback.js";
import { AppText, monoFontFamily } from "../ui/primitives.js";
import { AnswerPill } from "./answer-pill.js";

/**
 * A command an agent proposed, all of it, as web shows it: the Home's sentence, who asked, every
 * argument whole with what the Home knows beside it, the agent's words kept as its own, then
 * Decline or Approve. After Approve it says what the command came to.
 */
export function CommandRequestCard(props: {
  readonly hostClient: HostClient;
  readonly request: RequestView;
  readonly view: CommandRequestView;
  readonly disabled: boolean;
  readonly highlighted?: boolean;
}): ReactNode {
  const { hostClient, request } = props;
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<CommandRequestOutcome | null>(null);
  const approve = useScreenAction(hostClient, `command-approve:${request.id}`, {
    label: "approve it",
    done: "approved",
    happened: "your approval was sent",
    execute: async () => {
      const result = (await hostClient.dispatch(
        commandApproval(request, mutationIdempotencyKey(`command-approve:${request.id}`), typed),
      )) as { readonly outcome?: CommandRequestOutcome };
      if (result.outcome) setOutcome(result.outcome);
      return result;
    },
  });
  const decline = useScreenAction(hostClient, `request:${request.id}`, {
    label: "send your answer",
    done: "sent",
    happened: "your answer was sent",
    execute: () =>
      hostClient.dispatch(commandDecline(request, mutationIdempotencyKey(`request:${request.id}`))),
  });
  // What the approval came to, as soon as the Home answers it.
  const view = outcome
    ? commandRequestView({
        ...request,
        status: "fulfilled",
        command: { ...request.command!, outcome },
      })!
    : props.view;
  const busy = props.disabled || approve.running || decline.running;
  const missing = view.secrets.some(({ path }) => !typed[path]);
  const line = approve.line ?? decline.line;
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
      <View accessibilityLabel="The change, as proposed" style={styles.rows}>
        {view.rows.map((row) => (
          <View
            key={row.path}
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
      {view.approve
        ? view.secrets.map((secret) => (
            <TextInput
              accessibilityLabel={`${secret.label} · ${commandRequestWords.secret}`}
              autoCapitalize="none"
              autoCorrect={false}
              key={secret.path}
              onChangeText={(value) => setTyped({ ...typed, [secret.path]: value })}
              placeholder={`${secret.label} · ${commandRequestWords.secret}`}
              placeholderTextColor={color.muted}
              secureTextEntry
              style={styles.secret}
              value={typed[secret.path] ?? ""}
            />
          ))
        : null}
      <AppText role="caption" tone="muted">
        {view.line}
      </AppText>
      {view.approve && view.decline ? (
        <View style={styles.answers}>
          <AnswerPill
            disabled={busy}
            fill
            label={view.decline.label}
            onPress={() => void decline.run(undefined)}
            tone="secondary"
          />
          <AnswerPill
            busy={approve.running}
            disabled={busy || missing}
            fill
            label={view.approve.label}
            onPress={() => void approve.run(undefined)}
            tone="primary"
          />
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
  secret: {
    borderColor: color.muted,
    borderRadius: radius.md,
    borderWidth: 1,
    color: color.text,
    paddingHorizontal: space[10],
    paddingVertical: space[8],
  },
});
