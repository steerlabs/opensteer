import { Modal, ScrollView, View } from "react-native";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { useComputerAppApproval as useOwnerComputerAppApproval } from "@opensteer/client/react";
import { computerAppApprovalDetails } from "@opensteer/client/integrations";
import type { HostClient } from "@opensteer/client/host";
import { useState } from "react";

import { color, space } from "../theme.js";

export function useComputerAppApproval(hostClient: HostClient) {
  const { ask, review, error, busy, close, answer } = useOwnerComputerAppApproval(hostClient);
  const dialog = review ? (
    <Modal visible presentationStyle="pageSheet" onRequestClose={close}>
      <View
        style={{
          flex: 1,
          backgroundColor: color.background,
          padding: space[24],
          paddingTop: space[48],
        }}
      >
        <ScrollView>
          <AppText role="title">Allow agent access?</AppText>
          <AppText role="body">{computerAppApprovalDetails(review)}</AppText>
          {error ? <AppText role="body">{error}</AppText> : null}
        </ScrollView>
        <SecondaryButton label="Don't allow" disabled={busy} onPress={() => void answer("deny")} />
        <SecondaryButton label="Allow" disabled={busy} onPress={() => void answer("allow")} />
      </View>
    </Modal>
  ) : null;
  return { ask, dialog };
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
