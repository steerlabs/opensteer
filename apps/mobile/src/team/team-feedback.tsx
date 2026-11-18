import type { ClientSession } from "@opensteer/client/connections";
import { clientIssue, presentClientIssue } from "@opensteer/client/feedback";
import { useCallback, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { actOnce, outcomeLine } from "../ui/client-feedback.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import { Screen } from "../ui/screen.js";

/**
 * A screen's taps on a team, each answered by one line until the next tap:
 * `attempt` resolves true only once the team confirmed it.
 */
export function useTeamOutcomes(): {
  readonly line: ActionLineValue | null;
  readonly attempt: (
    on: ClientSession,
    spec: { readonly label: string; readonly done: string; readonly happened?: string },
    work: () => Promise<unknown>,
  ) => Promise<boolean>;
  readonly say: (line: ActionLineValue | null) => void;
} {
  const [line, say] = useState<ActionLineValue | null>(null);
  const attempt = useCallback(
    (
      on: ClientSession,
      spec: { readonly label: string; readonly done: string; readonly happened?: string },
      work: () => Promise<unknown>,
    ) =>
      actOnce(on, spec, work).then((outcome) => {
        say(outcomeLine(outcome));
        return outcome.kind === "confirmed";
      }),
    [],
  );
  return { line, attempt, say };
}

/** A screen's last outcome, at its top, where a menu's answer goes once the menu is gone. */
export function TeamOutcomeLine(props: {
  readonly line: ActionLineValue | null;
  readonly onDismiss: () => void;
}): ReactNode {
  if (props.line === null) return null;
  return (
    <View style={styles.outcome}>
      <ActionLine line={props.line} numberOfLines={2} onDismiss={props.onDismiss} />
    </View>
  );
}

/** What a team screen shows before its content arrives: still rows, or why it didn't. */
export function TeamWaiting(props: { readonly line?: ActionLineValue | null }): ReactNode {
  return (
    <Screen>
      <View style={styles.waiting}>
        {props.line ? <ActionLine line={props.line} /> : <PlaceholderRows count={6} />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  outcome: { paddingHorizontal: space[16], paddingVertical: space[8] },
  waiting: { flex: 1, justifyContent: "center", padding: space[16] },
});

/**
 * Words for a failure of work outside a team session (Account, this phone): the
 * caller's own sentence for a refusal, the shared presenter's for anything
 * uncertain. Never the error's own text.
 */
export function teamFailureWords(error: unknown, refused: string): string {
  const issue = clientIssue(error, { operation: "action", label: "complete this action" });
  if (issue === null || issue.code === "rejected") return refused;
  return presentClientIssue(issue).title;
}
