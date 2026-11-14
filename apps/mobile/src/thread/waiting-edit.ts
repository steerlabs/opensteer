import {
  HostClientRequestError,
  messageBody,
  type HostClient,
  type WaitingInput,
  type WaitingMessageEditor,
} from "@opensteer/client/host";
import type { ContentPart } from "@opensteer/core";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "react-native";
import { operationDetail } from "../client/mobile-client.js";

/** One waiting message open in place on this phone. */
export interface WaitingEdit {
  readonly messageId: string;
  readonly kind: WaitingInput["kind"];
  /** The words it opened with, so an untouched editor saves nothing. */
  readonly original: string;
  readonly text: string;
  /** Its files, pages and places that stay with it; removing one is part of the edit. */
  readonly parts: readonly ContentPart[];
  readonly originalParts: number;
  /**
   * `opening` until this phone holds the message, `saving` while a save is out,
   * `taken` once the Host said the message is no longer this edit's to change.
   */
  readonly phase: "opening" | "open" | "saving" | "taken";
  readonly failure: string | null;
}

export interface WaitingEditController {
  readonly edit: WaitingEdit | null;
  /** Why the last item could not be opened, under that item until it is tried again. */
  readonly refused: { readonly messageId: string; readonly detail: string } | null;
  readonly dirty: boolean;
  /** Something is left to save: words, or a file or place kept. */
  readonly savable: boolean;
  open(item: WaitingInput): void;
  change(text: string): void;
  removePart(index: number): void;
  cancel(): void;
  /** Saves and closes; resolves the revision saved, or null when nothing was. */
  save(): Promise<number | null>;
  /** Closes the editor and hands its words and kept parts back for a new message. */
  takeBack(): { readonly text: string; readonly parts: readonly ContentPart[] } | null;
}

interface Session {
  readonly messageId: string;
  editor: WaitingMessageEditor | null;
  closed: boolean;
}

/**
 * The one waiting message this phone edits in place. Opening it takes the
 * message's edit lease, so no Run takes it, and nothing behind it overtakes
 * it, while the person types; Save and Cancel end the lease. The words stay
 * on screen through anything the Host says, so nothing typed is ever lost.
 */
export function useWaitingEdit(
  hostClient: HostClient,
  threadId: string,
  items: readonly WaitingInput[] | null,
): WaitingEditController {
  const [edit, setEdit] = useState<WaitingEdit | null>(null);
  const [refused, setRefused] = useState<WaitingEditController["refused"]>(null);
  const session = useRef<Session | null>(null);
  const latest = useRef(items);
  latest.current = items;
  const editRef = useRef(edit);
  editRef.current = edit;

  /**
   * Lets the field go before it leaves: Android hands the focus of a field
   * that disappears to the composer, which keeps the keyboard up as if a
   * message were still being written.
   */
  const settle = useCallback((): void => {
    Keyboard.dismiss();
    setEdit(null);
  }, []);

  const close = useCallback((): void => {
    const held = session.current;
    session.current = null;
    // Nothing open: the keyboard, if any, is another field's.
    if (held === null) {
      setEdit(null);
      return;
    }
    settle();
    held.closed = true;
    // An editor still opening lets its lease go as soon as it arrives.
    void held.editor?.cancel();
  }, [settle]);

  // Leaving the task lets the message go on to the agent.
  useEffect(() => close, [close, hostClient, threadId]);

  const open = useCallback(
    (item: WaitingInput): void => {
      if (session.current?.messageId === item.messageId) return;
      close();
      setRefused(null);
      const content = item.item.message.content;
      const parts = content.filter((part) => part.type !== "text");
      const original = messageBody(content);
      const held: Session = { closed: false, editor: null, messageId: item.messageId };
      session.current = held;
      setEdit({
        failure: null,
        kind: item.kind,
        messageId: item.messageId,
        original,
        originalParts: parts.length,
        parts,
        phase: "opening",
        text: original,
      });
      hostClient.editWaitingMessage(threadId, item.messageId).then(
        (editor) => {
          if (held.closed) {
            void editor.cancel();
            return;
          }
          held.editor = editor;
          // The take can find a newer version than the one drawn; untouched
          // words start from that one, or a save would quietly undo it.
          const current = latest.current?.find((row) => row.messageId === item.messageId);
          setEdit((shown) => {
            if (shown?.messageId !== item.messageId) return shown;
            const untouched = shown.text === shown.original && shown.parts.length === parts.length;
            if (!untouched || current === undefined || current.revision === item.revision)
              return { ...shown, phase: "open" };
            const fresh = current.item.message.content;
            const freshParts = fresh.filter((part) => part.type !== "text");
            return {
              ...shown,
              original: messageBody(fresh),
              originalParts: freshParts.length,
              parts: freshParts,
              phase: "open",
              text: messageBody(fresh),
            };
          });
        },
        (error: unknown) => {
          if (held.closed || session.current !== held) return;
          session.current = null;
          settle();
          setRefused({
            detail: operationDetail(error, "This message can’t be edited right now."),
            messageId: item.messageId,
          });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        },
      );
    },
    [close, hostClient, settle, threadId],
  );

  const change = useCallback((text: string): void => {
    session.current?.editor?.touch();
    setEdit((shown) => (shown === null ? shown : { ...shown, text }));
  }, []);

  const removePart = useCallback((index: number): void => {
    session.current?.editor?.touch();
    setEdit((shown) =>
      shown === null ? shown : { ...shown, parts: shown.parts.filter((_, at) => at !== index) },
    );
  }, []);

  const save = useCallback(async (): Promise<number | null> => {
    const held = session.current;
    const shown = editRef.current;
    if (held?.editor == null || shown === null || shown.phase !== "open") return null;
    const editor = held.editor;
    const text = shown.text.trim();
    const content: ContentPart[] = [
      ...(text === "" ? [] : [{ text, type: "text" as const }]),
      ...shown.parts,
    ];
    if (content.length === 0) return null;
    if (text === shown.original.trim() && shown.parts.length === shown.originalParts) {
      // Nothing changed: let the message go on as it was.
      close();
      return editor.revision;
    }
    setEdit({ ...shown, failure: null, phase: "saving" });
    try {
      const saved = await editor.save(content);
      if (session.current === held) {
        session.current = null;
        settle();
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return saved.revision;
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (session.current !== held) return null;
      const settled =
        error instanceof HostClientRequestError &&
        (error.code === "conflict" || error.code === "not_found");
      const gone = !latest.current?.some((row) => row.messageId === shown.messageId);
      setEdit((current) =>
        current?.messageId !== shown.messageId
          ? current
          : {
              ...current,
              failure: settled
                ? gone
                  ? shown.kind === "ask"
                    ? "This ask was answered or withdrawn before your edit was saved."
                    : "Your agent already took this message, so your edit wasn’t saved."
                  : operationDetail(error, "This message changed before your edit was saved.")
                : operationDetail(error, "Your edit wasn’t saved. Try again."),
              phase: settled ? "taken" : "open",
            },
      );
      return null;
    }
  }, [close, settle]);

  const takeBack = useCallback((): ReturnType<WaitingEditController["takeBack"]> => {
    const shown = editRef.current;
    if (shown === null) return null;
    close();
    return { parts: shown.parts, text: shown.text.trim() };
  }, [close]);

  const dirty =
    edit !== null &&
    (edit.text.trim() !== edit.original.trim() || edit.parts.length !== edit.originalParts);
  const savable = edit !== null && (edit.text.trim() !== "" || edit.parts.length > 0);
  return useMemo(
    () => ({
      cancel: close,
      change,
      dirty,
      edit,
      open,
      refused,
      removePart,
      save,
      savable,
      takeBack,
    }),
    [change, close, dirty, edit, open, refused, removePart, save, savable, takeBack],
  );
}
