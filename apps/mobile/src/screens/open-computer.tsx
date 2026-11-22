import { clientIssue } from "@opensteer/client/feedback";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, StyleSheet, View } from "react-native";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { ActionLine } from "../ui/action-line.js";
import { AppText, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { color, space } from "../theme.js";

/** Visible above any selected computer: a link must never silently disappear. */
export function OpenComputer(): ReactNode {
  const client = useMobileClient();
  const { pendingComputer: pending, account } = useMobileState();
  const [failure, setFailure] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  if (pending === null) return null;
  const run = (operation: () => Promise<void>, failed: string): void => {
    setFailure(null);
    void operation().catch((error: unknown) => {
      // Nothing to say to someone who cancelled.
      if (clientIssue(error, { operation: "action", label: failed }) !== null) setFailure(failed);
    });
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={() => client.cancelOpenComputer()}
      presentationStyle="pageSheet"
    >
      <View style={styles.sheet}>
        <AppText role="displayLarge">Open your computer</AppText>
        {pending.status === "needs-sign-in" ? (
          <PrimaryButton
            label="Sign in"
            disabled={!account.account.available || signingIn}
            onPress={() => {
              setSigningIn(true);
              run(async () => {
                try {
                  await client.signInAccount();
                } finally {
                  setSigningIn(false);
                }
              }, "Couldn't sign in. Try again.");
            }}
          />
        ) : pending.status === "finding" ? (
          <>
            <ActivityIndicator color={color.ember} />
            <AppText>Finding your computer…</AppText>
          </>
        ) : (
          <>
            <AppText>
              {pending.status === "not-listed"
                ? "This computer isn't in your Account yet"
                : pending.status === "offline"
                  ? "Your computer is offline"
                  : "Your computer could not be found. Try again."}
            </AppText>
            <PrimaryButton
              label="Try again"
              onPress={() =>
                run(() => client.retryOpenComputer(), "Couldn't look for your computer. Try again.")
              }
            />
            {pending.status === "not-listed" ? (
              <SecondaryButton
                label="Use a different account"
                onPress={() => run(() => client.signOutAccount(), "Couldn't sign out. Try again.")}
              />
            ) : null}
          </>
        )}
        {failure || account.account.detail ? (
          <ActionLine
            line={{
              key: failure ?? account.account.detail ?? "",
              text: failure ?? account.account.detail ?? "",
              tone: "muted",
            }}
          />
        ) : null}
        <SecondaryButton label="Cancel" onPress={() => client.cancelOpenComputer()} />
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: color.background,
    padding: space[24],
    gap: space[24],
    justifyContent: "center",
  },
});
