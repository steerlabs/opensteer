import { teamAskerLabel, teamAskAudienceLabel } from "@opensteer/client/team";
import { useState } from "react";
import type { NeedsYouTeamAskEntry } from "@opensteer/protocol";
import type { HostClient } from "@opensteer/client/host";
import { Dialog } from "./dialog.js";
import { TeamInputSource } from "../team/task-source-chip.js";

export function TeamAskReview({
  entry,
  client,
  onClose,
}: {
  entry: NeedsYouTeamAskEntry;
  client: HostClient;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { presentation: ask } = entry;
  const name = teamAskerLabel(ask.asker);
  const decide = async (decision: "approve" | "decline") => {
    setPending(true);
    setError(null);
    try {
      await client.dispatch({
        type: "teams.ask.decide",
        teamId: entry.teamId,
        requestId: entry.requestId,
        decision,
      });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send your decision.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title={name}
      onClose={onClose}
      footer={
        <>
          {error ? <p role="alert">{error}</p> : null}
          <button type="button" disabled={pending} onClick={() => void decide("decline")}>
            {entry.failureReason ? "Dismiss" : "Decline"}
          </button>
          {!entry.failureReason ? (
            <button type="button" disabled={pending} onClick={() => void decide("approve")}>
              Approve
            </button>
          ) : null}
        </>
      }
    >
      <TeamInputSource
        source={{
          ...ask.destination,
          messageId: ask.destination.threadRootId,
          audience: ask.audience,
        }}
      />
      <p>
        <small>{teamAskAudienceLabel(ask.audience)}</small>
      </p>
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{ask.bodyMarkdown}</p>
      {ask.attachments.map((file) => (
        <p key={file.id}>
          {file.filename} · {file.sizeBytes.toLocaleString()} bytes
        </p>
      ))}
      {entry.failureReason ? (
        <p role="alert">{entry.failureReason}</p>
      ) : (
        <>
          <p>
            <small>Expires {new Date(entry.consentExpiresAt).toLocaleString()}</small>
          </p>
          <p>
            Approving lets your agent use your things and post its answer in #
            {ask.audience.channelName}.
          </p>
        </>
      )}
    </Dialog>
  );
}
