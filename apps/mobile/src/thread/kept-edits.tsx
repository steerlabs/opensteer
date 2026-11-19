import {
  draftOfUnsentEdit,
  hostMessageOutbox,
  waitingDraftOutgoing,
  type HostClient,
  type UnsentEdit,
  type UnsentEdits,
} from "@opensteer/client/host";
import type { ContentPart } from "@opensteer/core";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { AnswerPill } from "./answer-pill.js";

/**
 * Words the person changed in a waiting message that is no longer waiting (a Run took it, or its
 * edit lease was lost), kept until they choose: send them as a new message, move them to the
 * task's message box, or discard them. Nothing moves them on its own, and each choice ends the
 * kept words only once its target holds them.
 */
export function KeptEdits(props: {
  readonly hostClient: HostClient;
  readonly records: { readonly edits: UnsentEdits; readonly scope: string } | null;
  readonly threadId: string;
  /** Every waiting message's id once the conversation is current; undefined until then. */
  readonly waitingIds: readonly string[] | undefined;
  /** Puts words into this task's message box; true once its draft durably holds them. */
  readonly moveToComposer: (words: {
    readonly parts: readonly ContentPart[];
    readonly text: string;
  }) => Promise<boolean>;
}): ReactNode {
  const { records, waitingIds } = props;
  const store = records?.edits;
  useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.version ?? noVersion,
    store?.version ?? noVersion,
  );
  useEffect(() => void store?.ready(), [store]);
  if (!records || !waitingIds) return null;
  const kept = records.edits
    .forThread(records.scope, props.threadId)
    .filter(({ messageId }) => !waitingIds.includes(messageId));
  if (!kept.length) return null;
  return (
    <View accessibilityLabel="Unsaved edits" style={styles.list}>
      {kept.map((edit) => (
        <KeptEdit
          edit={edit}
          hostClient={props.hostClient}
          key={edit.messageId}
          moveToComposer={props.moveToComposer}
          records={records}
        />
      ))}
    </View>
  );
}

const noSubscribe = () => () => undefined;
const noVersion = () => 0;

function KeptEdit(props: {
  readonly edit: UnsentEdit;
  readonly hostClient: HostClient;
  readonly records: { readonly edits: UnsentEdits; readonly scope: string };
  readonly moveToComposer: (words: {
    readonly parts: readonly ContentPart[];
    readonly text: string;
  }) => Promise<boolean>;
}): ReactNode {
  const { edit, records } = props;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // One action at a time, decided at the tap: a second tap in the same frame does nothing.
  const running = useRef(false);
  const words = waitingDraftOutgoing(draftOfUnsentEdit(edit));
  const act = async (action: () => Promise<boolean>, refused: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // The kept words end only once their new home holds them.
      if (await action())
        await records.edits.remove(records.scope, edit.threadId, edit.messageId, edit);
      else setNotice(refused);
    } catch {
      setNotice(refused);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const sendAsNew = () =>
    act(async () => {
      const outbox = hostMessageOutbox(props.hostClient);
      const login = props.hostClient.connection.getSnapshot().scope;
      if (!words || !outbox || !login) return false;
      await outbox.enqueue(
        {
          type: "thread.sendMessage",
          threadId: edit.threadId,
          delivery: "queue",
          // One key per kept version: sending it twice is the same message.
          idempotencyKey: `unsent-edit:${edit.messageId}:${edit.updatedAt}`,
          content: [...words.content],
        } as Parameters<typeof outbox.enqueue>[0],
        { expectedLogin: login },
      );
      return true;
    }, "These words couldn’t be sent. They’re still here.");
  return (
    <View style={styles.card}>
      <AppText role="caption" tone="muted">
        The message you were editing is no longer waiting. Your words are kept:
      </AppText>
      <AppText numberOfLines={4} role="body">
        {edit.text}
      </AppText>
      {notice === null ? null : (
        <AppText role="caption" tone="danger">
          {notice}
        </AppText>
      )}
      <View style={styles.actions}>
        <AnswerPill
          busy={busy}
          disabled={busy || !words}
          label="Send as new message"
          onPress={() => void sendAsNew()}
          tone="primary"
        />
        <AnswerPill
          disabled={busy || !words}
          label="Move to message box"
          onPress={() =>
            void act(
              () => (words ? props.moveToComposer(words) : Promise.resolve(false)),
              "Your message box couldn’t take these words. They’re still here.",
            )
          }
          tone="secondary"
        />
        <AnswerPill
          disabled={busy}
          label="Discard"
          onPress={() => void act(async () => true, "These words couldn’t be discarded.")}
          tone="secondary"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  card: { gap: space[4], paddingHorizontal: space[16], paddingVertical: space[8] },
  list: { gap: space[8] },
});
