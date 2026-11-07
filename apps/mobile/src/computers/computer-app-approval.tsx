import { StyleSheet, View } from "react-native";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { useComputerAppApproval as useOwnerComputerAppApproval } from "@opensteer/client/react";
import {
  computerAppApprovalDetails,
  computerAppApprovalSecretFields,
  localMcpSecretsToSend,
  type ComputerAppApprovalReview,
} from "@opensteer/client/integrations";
import type { HostClient } from "@opensteer/client/host";
import { useState } from "react";

import { space } from "../theme.js";
import { LocalMcpSecretFields } from "./local-mcp-secret-fields.js";

/**
 * `content` is the review itself; `dialog` puts it in its own sheet. iOS shows
 * one modal at a time, so a surface already in a sheet renders `content` there.
 */
export function useComputerAppApproval(hostClient: HostClient) {
  const { ask, review, error, busy, close, answer } = useOwnerComputerAppApproval(hostClient);
  const content = review ? (
    <ApprovalReview
      // A new review starts with empty fields.
      key={review.request.id}
      answer={answer}
      busy={busy}
      error={error}
      review={review}
    />
  ) : null;
  const dialog =
    content === null ? null : (
      <Sheet onClose={close} open title="Allow agent access?">
        <View style={styles.dialog}>{content}</View>
      </Sheet>
    );
  return { ask, close, content, dialog };
}

function ApprovalReview(props: {
  readonly answer: (
    decision: "allow" | "deny",
    secrets?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly review: ComputerAppApprovalReview;
}) {
  const fields = computerAppApprovalSecretFields(props.review);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  const allow = () => {
    const entered = localMcpSecretsToSend(fields, values);
    if (!entered.ok) {
      setInvalid(entered.message);
      return;
    }
    setInvalid(null);
    void props.answer("allow", entered.secrets);
  };
  const error = invalid ?? props.error;
  return (
    <View style={styles.review}>
      <AppText role="body">{computerAppApprovalDetails(props.review)}</AppText>
      <LocalMcpSecretFields
        disabled={props.busy}
        fields={fields}
        onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
        values={values}
      />
      {error ? (
        <AppText role="body" tone="danger">
          {error}
        </AppText>
      ) : null}
      <SecondaryButton
        label="Don't allow"
        disabled={props.busy}
        onPress={() => void props.answer("deny")}
      />
      <SecondaryButton label="Allow" disabled={props.busy} onPress={allow} />
    </View>
  );
}

export function ComputerSetupApprovals(props: {
  readonly hostClient: HostClient;
  readonly requests: readonly import("@opensteer/client/integrations").ComputerAppSetupSummary[];
  readonly onChanged: () => Promise<void>;
}) {
  const approval = useComputerAppApproval(props.hostClient);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function review(id: string) {
    setBusy(id);
    setError(null);
    try {
      await approval.ask(id);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't review this approval.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <View>
      {approval.dialog}
      {props.requests.map((request) => (
        <View key={request.id}>
          <AppText role="body">
            {request.server?.name ??
              request.app?.displayName ??
              (request.kind === "policy" ? "Automatic app approval" : request.definitionId)}
          </AppText>
          <SecondaryButton
            label="Review"
            disabled={busy !== null}
            onPress={() => void review(request.id)}
          />
        </View>
      ))}
      {error ? <AppText role="body">{error}</AppText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dialog: { paddingHorizontal: space[16], paddingTop: space[8] },
  review: { gap: space[12] },
});
