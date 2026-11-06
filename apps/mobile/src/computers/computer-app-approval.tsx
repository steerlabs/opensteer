import { Modal, ScrollView, StyleSheet, View } from "react-native";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { useComputerAppApproval as useOwnerComputerAppApproval } from "@opensteer/client/react";
import {
  computerAppApprovalDetails,
  computerAppApprovalSecretFields,
  localMcpSecretsToSend,
  type ComputerAppApprovalReview,
} from "@opensteer/client/integrations";
import type { HostClient } from "@opensteer/client/host";
import { useState } from "react";

import { color, material, radius, space } from "../theme.js";
import { LocalMcpSecretFields } from "./local-mcp-secret-fields.js";
import { useThreadServerApprovals } from "./thread-server-approvals.js";

export function useComputerAppApproval(hostClient: HostClient) {
  const { ask, review, error, busy, close, answer } = useOwnerComputerAppApproval(hostClient);
  const dialog = review ? (
    <ApprovalSheet
      // A new review starts with empty fields.
      key={review.request.id}
      answer={answer}
      busy={busy}
      close={close}
      error={error}
      review={review}
    />
  ) : null;
  return { ask, dialog };
}

function ApprovalSheet(props: {
  readonly answer: (
    decision: "allow" | "deny",
    secrets?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly busy: boolean;
  readonly close: () => void;
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
    <Modal visible presentationStyle="pageSheet" onRequestClose={props.close}>
      <View
        style={{
          flex: 1,
          backgroundColor: color.background,
          padding: space[24],
          paddingTop: space[48],
        }}
      >
        <ScrollView keyboardShouldPersistTaps="handled">
          <AppText role="title">Allow agent access?</AppText>
          <AppText role="body">{computerAppApprovalDetails(props.review)}</AppText>
          <LocalMcpSecretFields
            disabled={props.busy}
            fields={fields}
            onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
            values={values}
          />
          {error ? <AppText role="body">{error}</AppText> : null}
        </ScrollView>
        <SecondaryButton
          label="Don't allow"
          disabled={props.busy}
          onPress={() => void props.answer("deny")}
        />
        <SecondaryButton label="Allow" disabled={props.busy} onPress={allow} />
      </View>
    </Modal>
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

/** Plugin servers an agent in this Thread installed, waiting for the owner to allow them to start. */
export function ThreadServerApprovals(props: {
  readonly hostClient: HostClient;
  readonly threadId: string;
}) {
  const { requests, reload } = useThreadServerApprovals(props.hostClient, props.threadId);
  if (requests.length === 0) return null;
  return (
    <View style={styles.threadCard}>
      <AppText role="caption" tone="ember">
        Needs you
      </AppText>
      <ComputerSetupApprovals
        hostClient={props.hostClient}
        onChanged={reload}
        requests={requests}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  threadCard: {
    ...material.attention,
    borderRadius: radius.lg,
    gap: space[6],
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
});
