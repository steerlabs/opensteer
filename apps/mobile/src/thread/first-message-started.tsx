import type { HostClient } from "@opensteer/client/host";
import type { UserId } from "@opensteer/core";
import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import type { TaskStartRecord } from "../client/thread-drafts.js";
import { TranscriptHostClientContext } from "./attachment-views.js";
import { OwedMessageStatus, type OwedState } from "./owed-message.js";
import { owedMessageEntry } from "./owed-message-model.js";
import { Message } from "./transcript.js";

/** What a sent first message shows of itself, from the moment Send is pressed. */
export type FirstMessageSent = Pick<
  TaskStartRecord,
  "attachments" | "browserPage" | "idempotencyKey" | "text"
>;

/**
 * A first message once sent: the screen it was written on becomes the task
 * it starts, drawn as that task's transcript draws it, so the task taking over
 * moves nothing. It stays until the Host has made the task, and says so if
 * that takes a while or has to be tried again under the same keys.
 */
export function FirstMessageStarted(props: {
  readonly hostClient: HostClient;
  readonly message: FirstMessageSent;
  readonly onRetry: (() => void) | null;
  readonly state: OwedState;
  readonly userId: UserId;
}): ReactNode {
  const message = useMemo(
    () => owedMessageEntry(props.message, props.userId),
    [props.message, props.userId],
  );
  return (
    <TranscriptHostClientContext value={props.hostClient}>
      <View>
        <Message
          conversation={false}
          message={message}
          onOpenThread={noop}
          onReply={undefined}
          onToggle={noop}
          open={false}
          viewerUserId={props.userId}
        />
        <OwedMessageStatus
          idempotencyKey={props.message.idempotencyKey}
          onRetry={props.onRetry}
          state={props.state}
        />
      </View>
    </TranscriptHostClientContext>
  );
}

function noop(): void {}
