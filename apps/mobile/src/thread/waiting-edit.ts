import { classifyClientFailure } from "@opensteer/client/connections";
import { clientIssue, presentClientIssue } from "@opensteer/client/feedback";
import {
  followWaitingDraft,
  hydrateWaitingDraft,
  openWaitingDraft,
  reloadWaitingDraft,
  removeWaitingDraftPart,
  setWaitingDraftText,
  waitingDraftAwaits,
  waitingDraftOutgoing,
  waitingDraftSave,
  type HostClient,
  type WaitingDraft,
  type WaitingInput,
  type WaitingMessageEditor,
} from "@opensteer/client/host";
import type { ComposerEditorHandle } from "@opensteer/client/references";
import type { ContentPart } from "@opensteer/core";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { dismissKeyboard } from "../ui/composer-editor.js";
import { failureWords } from "../ui/client-feedback.js";

const editWords = {
  label: "save your edit",
  done: "saved",
  happened: "your edit was saved",
} as const;

/** One waiting message open in place on this phone. */
export interface WaitingEdit {
  readonly messageId: string;
  readonly kind: WaitingInput["kind"];
  /** Whose ask it is, named over the words; null for the person's own message. */
  readonly asker: string | null;
  /**
   * The words, bound to the version they were written against and kept true
   * to the version the Host reports: untouched words follow a newer one,
   * changed words hold it as their conflict.
   */
  readonly draft: WaitingDraft;
  /**
   * `opening` until this phone holds the message, `saving` while a save is out,
   * `away` while the task is out of sight and the message is let go, `refused`
   * when it could not be held.
   */
  readonly phase: "opening" | "open" | "saving" | "away" | "refused";
  /** Why it could not be held or saved, under the words until the next try. */
  readonly failure: string | null;
  readonly replyFull?: boolean;
  /** It left the line, taken by a Run or settled elsewhere; only its words are left. */
  readonly gone: boolean;
}

export interface WaitingEditController {
  readonly edit: WaitingEdit | null;
  /** The open editor's field; Save reads its last keystroke from it before saving. */
  readonly field: RefObject<ComposerEditorHandle | null>;
  open(item: WaitingInput): void;
  change(text: string): void;
  removePart(index: number): void;
  /** Lets the words go for the newer version that arrived under them. */
  reload(): void;
  /** Tries again to hold a message that could not be held, keeping the words. */
  retry(): void;
  cancel(): void;
  /**
   * Saves and closes; an untouched edit just closes. Resolves the version now
   * waiting, the one an answer names, or null when nothing was saved.
   */
  save(): Promise<number | null>;
  /** Closes only after the reply draft has taken the words and files. */
  moveToDraft(
    keep: (words: {
      readonly text: string;
      readonly parts: readonly ContentPart[];
    }) => Promise<boolean>,
  ): Promise<void>;
}

/** One hold on the message: from its take until saved, cancelled or let go. */
interface Lease {
  readonly messageId: string;
  editor: WaitingMessageEditor | null;
  /** Let go; an editor arriving after is ended at once. */
  ended: boolean;
  /** A save is out; it ends the lease itself, so nothing else may. */
  saving: boolean;
}

/**
 * The one waiting message this phone edits in place. Holding it takes the
 * message's edit lease, so no Run takes it, and nothing behind it overtakes
 * it, while the person types. The lease is held only while the task is in
 * front of them (`active`): out of sight it is let go and the words are kept,
 * and on return it is taken again and the words checked against whatever was
 * saved meanwhile. Nothing typed is lost to anything the Host says.
 */
export function useWaitingEdit(
  hostClient: HostClient,
  threadId: string,
  items: readonly WaitingInput[] | null,
  active: boolean,
  /** Where typed words go when the edit ends because the person left the task: the composer. */
  keepUnsent?: (
    threadId: string,
    words: { readonly text: string; readonly parts: readonly ContentPart[] },
  ) => Promise<boolean>,
): WaitingEditController {
  const keep = useRef(keepUnsent);
  keep.current = keepUnsent;
  const [kept, setKept] = useState<WaitingEdit | null>(null);
  const lease = useRef<Lease | null>(null);
  const moving = useRef(false);
  const field = useRef<ComposerEditorHandle>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // The words follow the Host's version on every render, except while a save
  // of them is out: the Host reports that save's version before it answers.
  let edit = kept;
  if (kept !== null && items !== null) {
    const current = items.find((item) => item.messageId === kept.messageId);
    const draft =
      current === undefined || kept.phase === "saving"
        ? kept.draft
        : followWaitingDraft(kept.draft, {
            content: [
              { type: "text", text: current.entry.body },
              ...(current.entry.attachments ?? []),
            ],
            revision: current.revision,
          });
    const gone = current === undefined;
    if (draft !== kept.draft || gone !== kept.gone) edit = { ...kept, draft, gone };
  }
  if (edit !== kept) setKept(edit);
  const editRef = useRef(edit);
  editRef.current = edit;

  const letGo = useCallback((): void => {
    const held = lease.current;
    lease.current = null;
    if (held === null) return;
    held.ended = true;
    if (!held.saving) void held.editor?.cancel();
  }, []);

  const take = useCallback(
    (messageId: string): void => {
      const held: Lease = { editor: null, ended: false, messageId, saving: false };
      lease.current = held;
      hostClient.editWaitingMessage(threadId, messageId).then(
        (editor) => {
          if (held.ended) {
            void editor.cancel();
            return;
          }
          held.editor = editor;
          setKept((shown) =>
            shown?.messageId === messageId
              ? {
                  ...shown,
                  draft: hydrateWaitingDraft(shown.draft, {
                    content: editor.content,
                    revision: editor.revision,
                    full: true,
                  }),
                  failure: null,
                  phase: "open",
                }
              : shown,
          );
        },
        (error: unknown) => {
          if (held.ended) return;
          lease.current = null;
          setKept((shown) =>
            shown?.messageId === messageId
              ? {
                  ...shown,
                  failure:
                    failureWords(error, editWords, "This message can’t be edited right now.") ?? "",
                  phase: "refused",
                }
              : shown,
          );
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        },
      );
    },
    [hostClient, threadId],
  );

  // A newer version locks the field until its full body is read under the lease.
  const awaited = edit === null ? null : waitingDraftAwaits(edit.draft);
  const phase = edit?.phase;
  useEffect(() => {
    const held = lease.current;
    const editor = held?.editor;
    if (awaited === null || !held || !editor || editor.revision === awaited) return;
    let current = true;
    editor.read(awaited).then(
      (content) => {
        if (!current || lease.current !== held) return;
        setKept((shown) =>
          shown?.messageId === held.messageId
            ? {
                ...shown,
                draft: hydrateWaitingDraft(shown.draft, { content, revision: awaited, full: true }),
              }
            : shown,
        );
      },
      (error: unknown) => {
        if (!current || lease.current !== held) return;
        setKept((shown) =>
          shown?.messageId === held.messageId
            ? {
                ...shown,
                failure:
                  failureWords(error, editWords, "This message can’t be edited right now.") ?? "",
              }
            : shown,
        );
      },
    );
    return () => {
      current = false;
    };
  }, [awaited, phase]);

  const close = useCallback((): void => {
    letGo();
    // Nothing open: the keyboard, if any, is another field's. Otherwise the
    // field lets go first: Android hands the focus of a field that disappears
    // to the composer, which keeps the keyboard up as if a message were still
    // being written.
    if (editRef.current !== null) void dismissKeyboard();
    setKept(null);
  }, [letGo]);

  // Leaving the task lets the message go on to the agent; words typed into it stay the person's,
  // in the task's composer, rather than going with the view.
  useEffect(
    () => () => {
      const shown = editRef.current;
      const words = shown?.draft.dirty ? waitingDraftOutgoing(shown.draft) : null;
      if (words && lease.current?.saving !== true)
        void keep.current?.(threadId, { parts: words.parts, text: words.text }).catch(() => false);
      close();
    },
    [close, hostClient, threadId],
  );

  // Out of sight, the message goes on without this phone's hold; back in
  // front, the hold is taken again. A save under way finishes either way.
  useEffect(() => {
    const shown = editRef.current;
    if (shown === null) return;
    if (!active) {
      if (shown.phase === "away" || lease.current?.saving === true || moving.current) return;
      letGo();
      setKept((current) => (current === null ? current : { ...current, phase: "away" }));
    } else if (shown.phase === "away") {
      setKept((current) =>
        current === null ? current : { ...current, failure: null, phase: "opening" },
      );
      take(shown.messageId);
    }
  }, [active, letGo, take]);

  const open = useCallback(
    (item: WaitingInput): void => {
      if (
        editRef.current?.messageId === item.messageId ||
        lease.current?.saving === true ||
        moving.current
      )
        return;
      close();
      setKept({
        asker: item.kind === "ask" ? item.asker : null,
        // The preview shows while the full body is read; it cannot be edited or saved.
        draft: openWaitingDraft({
          content: [{ type: "text", text: item.entry.body }, ...(item.entry.attachments ?? [])],
          revision: item.revision,
        }),
        failure: null,
        gone: false,
        kind: item.kind,
        messageId: item.messageId,
        phase: activeRef.current ? "opening" : "away",
      });
      if (activeRef.current) take(item.messageId);
    },
    [close, take],
  );

  const retry = useCallback((): void => {
    const shown = editRef.current;
    if (shown?.phase !== "refused" || !activeRef.current) return;
    setKept({ ...shown, failure: null, phase: "opening" });
    take(shown.messageId);
  }, [take]);

  const change = useCallback((text: string): void => {
    lease.current?.editor?.touch();
    setKept((shown) =>
      shown === null ? shown : { ...shown, draft: setWaitingDraftText(shown.draft, text) },
    );
  }, []);

  const removePart = useCallback((index: number): void => {
    lease.current?.editor?.touch();
    setKept((shown) =>
      shown === null ? shown : { ...shown, draft: removeWaitingDraftPart(shown.draft, index) },
    );
  }, []);

  const reload = useCallback((): void => {
    setKept((shown) =>
      shown?.draft.conflict
        ? { ...shown, draft: reloadWaitingDraft(shown.draft), failure: null }
        : shown,
    );
  }, []);

  const save = useCallback(async (): Promise<number | null> => {
    const held = lease.current;
    const opened = editRef.current;
    if (
      held?.editor == null ||
      held.saving ||
      opened === null ||
      opened.phase !== "open" ||
      opened.gone
    )
      return null;
    const editor = held.editor;
    // Held from here, so a second Save waits and closing keeps the lease for this one.
    held.saving = true;
    // The field's last keystroke can still be on its way to React: save what it holds now.
    const input = field.current;
    const flushed =
      input === null
        ? null
        : await input.flushPendingInput(input.readSnapshot().generation).catch(() => null);
    const shown = editRef.current;
    if (
      flushed?.composing === true ||
      lease.current !== held ||
      shown === null ||
      shown.messageId !== opened.messageId ||
      shown.phase !== "open" ||
      shown.gone
    ) {
      held.saving = false;
      if (held.ended) void editor.cancel();
      return null;
    }
    const draft =
      flushed === null || flushed.text === shown.draft.text
        ? shown.draft
        : setWaitingDraftText(shown.draft, flushed.text);
    const plan = waitingDraftSave(draft);
    if (plan === null || plan.kind === "unchanged") {
      held.saving = false;
      if (plan === null) return null;
      // Nothing changed: let the message go on as it was.
      close();
      return plan.revision;
    }
    setKept({ ...shown, draft, failure: null, phase: "saving" });
    try {
      const saved = await editor.save(plan.content, plan.expectedRevision);
      held.saving = false;
      // Only the edit this save came from closes; it ended the lease itself.
      if (lease.current === held) {
        lease.current = null;
        void dismissKeyboard();
        setKept(null);
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return saved.revision;
    } catch (error) {
      held.saving = false;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (lease.current !== held) {
        void editor.cancel();
        return null;
      }
      const away = !activeRef.current;
      if (away) letGo();
      const { code, kind } = classifyClientFailure(error);
      const settled = kind === "rejection" && (code === "conflict" || code === "not_found");
      setKept((current) =>
        current?.messageId !== shown.messageId
          ? current
          : {
              ...current,
              failure: settled
                ? failureWords(error, editWords, "This message changed before your edit was saved.")
                : failureWords(error, editWords, "Your edit wasn’t saved. Try again."),
              phase: away ? "away" : "open",
            },
      );
      return null;
    }
  }, [close, letGo]);

  const moveToDraft = useCallback<WaitingEditController["moveToDraft"]>(
    async (keep) => {
      const opened = editRef.current;
      if (opened === null || lease.current?.saving === true || moving.current) return;
      moving.current = true;
      try {
        const input = field.current;
        const flushed = await input
          ?.flushPendingInput(input.readSnapshot().generation)
          .catch(() => null);
        const shown = editRef.current;
        if (flushed?.composing || shown?.messageId !== opened.messageId) return;
        const draft = flushed ? setWaitingDraftText(shown.draft, flushed.text) : shown.draft;
        // Only words built on the full body leave: never the queue's clipped preview.
        const outgoing = waitingDraftOutgoing(draft);
        if (outgoing === null) return;
        setKept({ ...shown, draft, failure: null, phase: "saving", replyFull: false });
        let issue = null;
        try {
          if (await keep({ parts: outgoing.parts, text: outgoing.text })) {
            if (editRef.current?.messageId === shown.messageId) close();
            return;
          }
        } catch (error) {
          issue = clientIssue(error, { operation: "action", label: "save this draft" });
        }
        const limit = issue?.code === "draft-limit" ? issue : null;
        const failure = presentClientIssue(limit ?? { code: "draft-unsaved" }).title;
        setKept((current) =>
          current?.messageId === shown.messageId
            ? { ...current, failure, phase: shown.phase, replyFull: limit !== null }
            : current,
        );
      } finally {
        moving.current = false;
      }
    },
    [close],
  );

  return useMemo(
    () => ({
      cancel: close,
      change,
      edit,
      field,
      open,
      reload,
      removePart,
      retry,
      save,
      moveToDraft,
    }),
    [change, close, edit, open, reload, removePart, retry, save, moveToDraft],
  );
}
