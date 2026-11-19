import {
  draftOfUnsentEdit,
  hostMessageOutbox,
  waitingDraftOutgoing,
  type HostClient,
  type UnsentEdit,
} from "@opensteer/client/host";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sendMessageCommand } from "../host/message-outbox.js";
import { composerDraftKeyFor, composerDrafts } from "./composer-drafts.js";
import { unsentEditScope, unsentEdits } from "./unsent-edits.js";

/**
 * Words the person changed in a waiting message that is no longer waiting (a Run took it, or its
 * edit lease was lost), kept until they choose: send them as a new message, move them to this
 * task's composer, or discard them. Nothing moves them on its own; each choice ends the kept words
 * only once its target holds them.
 */
export function KeptEdits({
  client,
  threadId,
  waitingIds,
}: {
  readonly client: HostClient;
  readonly threadId: string;
  /** Every waiting message's id once the conversation is current; undefined until then. */
  readonly waitingIds: readonly string[] | undefined;
}) {
  useSyncExternalStore(unsentEdits.subscribe, unsentEdits.version, unsentEdits.version);
  useEffect(() => void unsentEdits.ready(), []);
  const scope = unsentEditScope(client);
  if (!scope || !waitingIds) return null;
  const kept = unsentEdits
    .forThread(scope, threadId)
    .filter(({ messageId }) => !waitingIds.includes(messageId));
  if (!kept.length) return null;
  return (
    <ul aria-label="Unsaved edits" className="kept-edits">
      {kept.map((edit) => (
        <KeptEdit client={client} edit={edit} key={edit.messageId} scope={scope} />
      ))}
    </ul>
  );
}

function KeptEdit({
  client,
  edit,
  scope,
}: {
  readonly client: HostClient;
  readonly edit: UnsentEdit;
  readonly scope: string;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const words = waitingDraftOutgoing(draftOfUnsentEdit(edit));
  // One action at a time, decided at the click: a second click in the same frame does nothing.
  const running = useRef(false);
  const act = async (action: () => Promise<boolean>, refused: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // The kept words end only once their new home holds them.
      if (await action()) await unsentEdits.remove(scope, edit.threadId, edit.messageId, edit);
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
      const outbox = hostMessageOutbox(client);
      const login = client.connection.getSnapshot().scope;
      if (!words || !outbox || !login) return false;
      await outbox.enqueue(
        sendMessageCommand(edit.threadId, {
          attachments: [],
          body: words.text,
          content: [...words.content],
          // One key per kept version: sending it twice is the same message.
          idempotencyKey: `unsent-edit:${edit.messageId}:${edit.updatedAt}`,
        }),
        { expectedLogin: login },
      );
      return true;
    }, "These words couldn’t be sent. They’re still here.");
  const moveToComposer = () =>
    act(async () => {
      const { deploymentId, user } = client.getSnapshot();
      const key = composerDraftKeyFor(deploymentId, user?.id, {
        kind: "thread",
        threadId: edit.threadId,
      });
      if (!words || !key) return false;
      return composerDrafts.handBack(key, {
        edit: (text) => (text.trim() ? `${words.text}\n\n${text}` : words.text),
        files: words.parts.flatMap((part) =>
          part.type === "artifact"
            ? [{ mediaType: part.mediaType, name: part.name, part, sizeBytes: part.sizeBytes ?? 0 }]
            : [],
        ),
      });
    }, "Your message box couldn’t take these words. They’re still here.");
  const discard = () => act(async () => true, "These words couldn’t be discarded.");
  return (
    <li className="kept-edit">
      <p className="kept-edit__lead">
        The message you were editing is no longer waiting. Your words are kept:
      </p>
      <p className="kept-edit__words">{edit.text}</p>
      {notice ? (
        <p className="kept-edit__notice" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="kept-edit__actions">
        <button
          className="btn btn--small btn--primary"
          disabled={busy || !words}
          onClick={() => void sendAsNew()}
          type="button"
        >
          Send as new message
        </button>
        <button
          className="btn btn--small"
          disabled={busy || !words}
          onClick={() => void moveToComposer()}
          type="button"
        >
          Move to message box
        </button>
        <button
          className="btn btn--small"
          disabled={busy}
          onClick={() => void discard()}
          type="button"
        >
          Discard
        </button>
      </div>
    </li>
  );
}
