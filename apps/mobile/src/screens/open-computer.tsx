import { useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, StyleSheet, View } from "react-native";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { color, space } from "../theme.js";
import { operationDetail } from "../client/mobile-client.js";

/** Visible above any selected computer: a link must never silently disappear. */
export function OpenComputer(): ReactNode {
  const client = useMobileClient();
  const { pendingComputer: pending, account } = useMobileState();
  const [failure, setFailure] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  if (pending === null) return null;
  const run = (operation: () => Promise<void>): void => {
    setFailure(null);
    void operation().catch((error: unknown) => setFailure(operationDetail(error, "Try again.")));
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
              });
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
              onPress={() => run(() => client.retryOpenComputer())}
            />
            {pending.status === "not-listed" ? (
              <SecondaryButton
                label="Use a different account"
                onPress={() => run(() => client.signOutAccount())}
              />
            ) : null}
          </>
        )}
        {failure || account.account.detail ? (
          <Notice title="Account" detail={failure ?? account.account.detail ?? ""} />
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
