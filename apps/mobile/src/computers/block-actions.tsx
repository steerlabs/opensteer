import { useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { space } from "../theme.js";
import { AppText } from "../ui/primitives.js";

/** A failed action and the key of what it was acting on, so the error sits there. */
type Failure = { readonly key: string; readonly message: string };

/**
 * One change at a time from a block, each with its own busy key, so a failure
 * sits beside what it was acting on.
 */
export function useBlockActions(
  canRespond: boolean,
  onChanged: () => Promise<void>,
): {
  readonly busy: string | null;
  readonly failureFor: (key: string) => string | null;
  readonly run: (key: string, operation: () => Promise<void>) => void;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const acting = useRef(false);

  const run = (key: string, operation: () => Promise<void>): void => {
    if (acting.current || !canRespond) return;
    acting.current = true;
    setBusy(key);
    setFailure(null);
    void operation()
      // A reload that fails after the change landed is not the change failing;
      // the next machine update brings the list up to date.
      .then(() => onChanged().catch(() => undefined))
      .catch((error: unknown) =>
        setFailure({ key, message: operationDetail(error, "That did not change anything.") }),
      )
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
    <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.failure}>
      <AppText role="caption" tone="danger">
        {props.detail}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  failure: { paddingBottom: space[12], paddingHorizontal: space[16] },
});
