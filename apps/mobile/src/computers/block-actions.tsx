import type { ClientSession } from "@opensteer/client/connections";
import { clientIssue, presentClientIssue } from "@opensteer/client/feedback";
import { useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/** An action that didn't land and the key of what it was acting on, so its line sits there. */
type Failure = { readonly key: string; readonly message: string };

/**
 * One change at a time from a block, each with its own busy key, so its
 * outcome sits beside what it was acting on. A tap while disconnected is
 * answered at once and never sent; a lost answer says it couldn't confirm;
 * a refusal gives the computer's safe reason. Never raw error text.
 */
export function useBlockActions(
  canRespond: boolean,
  onChanged: () => Promise<void>,
  session?: ClientSession,
): {
  readonly busy: string | null;
  readonly failureFor: (key: string) => string | null;
  readonly run: (key: string, operation: () => Promise<void>) => void;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const acting = useRef(false);

  const run = (key: string, operation: () => Promise<void>): void => {
    if (acting.current) return;
    if (!canRespond) {
      const state = session?.connection.getSnapshot();
      setFailure({
        key,
        message: presentClientIssue({
          code: "not-sent",
          reason: state?.network === "offline" ? "offline" : "unreachable",
          ...(state?.name ? { name: state.name } : {}),
        }).title,
      });
      return;
    }
    acting.current = true;
    setBusy(key);
    setFailure(null);
    void operation()
      // A reload that fails after the change landed is not the change failing;
      // the next machine update brings the list up to date.
      .then(() => onChanged().catch(() => undefined))
      .catch((error: unknown) => {
        const issue = clientIssue(error, { operation: "action", label: "change this" });
        if (issue !== null) setFailure({ key, message: presentClientIssue(issue).title });
        // Whatever the answer, what the computer has now is what the block shows.
        void onChanged().catch(() => undefined);
      })
      .finally(() => {
        acting.current = false;
        setBusy(null);
      });
  };

  return {
    busy,
    failureFor: (key) => (failure?.key === key ? failure.message : null),
    run,
  };
}

export function FailureText(props: { readonly detail: string | null }): ReactNode {
  return props.detail === null ? null : (
    <View accessibilityLiveRegion="polite" style={styles.failure}>
      <AppText role="caption" tone="muted">
        {props.detail}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  failure: { paddingBottom: space[12], paddingHorizontal: space[16] },
});
