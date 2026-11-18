import { clientIssue, presentClientIssue } from "@opensteer/client/feedback";
import { ActionNotDone, failureWords } from "./use-action.js";

const isNotDone = (error: unknown) => error instanceof ActionNotDone;
import { compactionOfferText } from "@opensteer/client/host";
import {
  dictationLabels,
  dictationView,
  dictationStartLabel,
  type DictationSelection,
} from "@opensteer/client/dictation";
import { DictationStatus, DictationLive, useDictation } from "./dictation.js";
import { useVoiceOn } from "@opensteer/client/react";
import { observeResize } from "@opensteer/shared/resizeObserver";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { type ArtifactContentPart, type PlaceContentPart } from "@opensteer/core";
import type { PendingSubmission } from "../host/message-outbox.js";
import { mutationIdempotencyKey, type HostClient, type PlaceItem } from "@opensteer/client/host";
import { collectComposerTokens, type ComposerSnapshot } from "@opensteer/client/references";
import { AttachmentTray, filesWaitLine } from "./attachments/attachment-tray.js";
import {
  ComposerEditor,
  type ComposerChange,
  type ComposerEditorControl,
} from "./composer-editor.js";
import { useReferencePicker, type ComposerLinkCandidate } from "./composer-reference-picker.js";
import type { ComposerContext, ContextChip } from "./workspace/composer-context.js";
import { AttachMenu, pickablePlaces } from "./workspace/place-picker.js";
import { PlaceMark } from "./workspace/place-mark.js";
import { useFocusRescue } from "./workspace/occupant-marks.js";
import {
  useStagedAttachments,
  type AttachmentTarget,
} from "./attachments/use-staged-attachments.js";
import { composerDrafts, type ReturnedToDraft } from "./composer-drafts.js";
import { composerFold, FoldRow, FoldToFit } from "./fold-to-fit.js";
import { Icon } from "./icon.js";
import { canvasFont, textWidth } from "./text-width.js";

/**
 * A message this one answers, named by its exact source id. The excerpt and
 * attribution are shown to the reader; only the id travels with the send, so
 * the Host resolves the quote from authorized history rather than from text a
 * client assembled.
 */
export interface ComposerQuote {
  /** Who said it, as the transcript already names them. */
  readonly attribution: string;
  /** A short, visible piece of the quoted message — never the authorization. */
  readonly excerpt: string;
  readonly messageId: string;
}

/** What a send carries beside its words. */
export interface ComposerSubmission {
  readonly compaction?: import("@opensteer/core").CompactionSendChoice;
  /** The places the message includes — pages, Mac apps, phones — as the draft held them. */
  readonly places: readonly PlaceContentPart[];
  /** Uploaded files, in the order the person added them. */
  readonly attachments: readonly ArtifactContentPart[];
  readonly idempotencyKey: string;
  /** The exact source message this one answers, when the reader quoted one. */
  readonly quotedMessageId?: string;
}

/** A message handed back to the composer, such as a queued one taken back to be reworded. */
export interface ComposerRestore {
  readonly attachments?: readonly ArtifactContentPart[];
  /**
   * Places the message carried, every one, as chips. An empty array is a
   * choice too: the draft carries nothing and does not follow the page.
   */
  readonly places?: readonly PlaceContentPart[];
  readonly key: number;
  /**
   * A report the reader chose to ask about. It joins the composer as a chip
   * they can remove; it never becomes draft text, because words typed by a
   * person and words published by an agent are not the same authorization.
   */
  readonly quote?: ComposerQuote | null;
  readonly text: string;
}

interface ComposerProps {
  compactionOffer?: { visible: boolean; dismiss: () => void };
  dictationScope?: string;
  hidden?: boolean;
  variant?: "conversation" | "work";
  /**
   * No AI is chosen yet: the footer's "Choose AI" is the primary action, so
   * the send button stays away until there is something to send with.
   */
  settingsRequired?: boolean;
  /**
   * References `@` can write into the words, for a query; each is inserted as
   * its Markdown link. Without it `@` offers places only.
   */
  references?: ((query: string) => readonly ComposerLinkCandidate[]) | null | undefined;
  /** Where attached files are uploaded; without it the composer takes words only. */
  attachments?: AttachmentTarget | null | undefined;
  autoFocus?: boolean;
  /**
   * The draft's places: what it carries beside its words, and the list `+` and
   * `@` attach from. Without it the composer takes words and files only.
   */
  placeContext?: { readonly context: ComposerContext; readonly hostClient: HostClient } | null;
  disabled?: boolean;
  readOnly?: boolean;
  footerExtras?: ReactNode;
  /** Chat's voice button, beside Send. */
  voice?: ReactNode;
  /**
   * The editable field, published so a surface that took the keyboard away —
   * the AI picker's review, a Find panel — can give it back to the words.
   */
  inputRef?: React.RefObject<HTMLElement | null> | undefined;
  /**
   * Where this draft is kept. Fixed for the life of a composer: a parent that
   * shows another draft mounts another composer, and its place context with it.
   */
  draftKey?: string | null | undefined;
  /**
   * Whether anything is in this composer: words, files, a quote, or a send
   * still in flight. A surface that another route may replace asks for this
   * before it takes the composer away.
   */
  onHoldingChange?: ((holding: boolean) => void) | undefined;
  /** Invoked when the reader presses Escape in the textarea (e.g. to return focus to docked action options). */
  onEscape?: (() => void) | undefined;
  /**
   * Keeps or sends the message. A rejection from `act` is said in the
   * action owner's words; anything else as a message this device couldn't keep.
   */
  onSend: (
    body: string,
    submission: ComposerSubmission,
  ) => Promise<void | { readonly draftGeneration: string }>;
  onStop?: (() => Promise<void>) | undefined;
  placeholder: string;
  /**
   * Whom the message goes to, for the field to name — "Ask Opensteer…",
   * "Reply to Friday dinner…" — with the name shortened to fit. With a place
   * attached it asks about that place, when the longer form fits whole.
   */
  recipient?: ComposerRecipient | null;
  /** Why nothing can be sent or attached right now; the draft stays editable. */
  sendBlocked?: string | null | undefined;
  /** Each new value joins the draft once, ahead of what is there. */
  restore?: ComposerRestore | null;
  /** Shows the stop affordance while a run is executing. */
  running?: boolean;
  sendLabel?: string;
  /** Names what Stop stops, where more than one thing on screen can be stopped. */
  stopLabel?: string;
  /** A Stop already asked for and not yet confirmed by the Run ending. */
  stopping?: boolean;
}

/** The words before a recipient's name, and the name: "Reply to" · "Friday dinner". */
export interface ComposerRecipient {
  readonly lead: string;
  readonly name: string;
}

const nothingSending: ReadonlySet<string> = new Set();
const noPlaces: readonly PlaceItem[] = [];

/**
 * The message composer: auto-growing textarea, Enter to send (Shift+Enter for
 * a newline, IME-safe), and independent send/stop actions. Given an upload
 * target it also takes files, chosen, pasted or dropped, and holds the send
 * until every one of them is on the Host.
 *
 * Given somewhere to keep it, a message whose answer never came stays above
 * the field as it was sent, and only "Send again" sends it, under the same
 * key. What is typed meanwhile is a separate, later message.
 */
export function Composer({
  dictationScope = "composer",
  hidden = false,
  variant = "work",
  settingsRequired = false,
  attachments = null,
  autoFocus,
  placeContext = null,
  references = null,
  disabled = false,
  readOnly = false,
  footerExtras,
  voice,
  inputRef,
  draftKey = null,
  onHoldingChange,
  onEscape,
  onSend,
  compactionOffer,
  onStop,
  placeholder,
  recipient = null,
  restore = null,
  running = false,
  sendBlocked = null,
  sendLabel = "Send message",
  stopLabel = "Stop the run",
  stopping: runStopping = false,
}: ComposerProps) {
  const [saved] = useState(() => (draftKey ? composerDrafts.read(draftKey) : null));
  const [draft, setDraft] = useState(saved?.text ?? "");
  const { controller: dictation, snapshot: speech } = useDictation();
  const onCall = useVoiceOn();
  const instance = useId();
  const owner = `${dictationScope}/${instance}`;
  const view = dictationView(speech, owner);
  const dictating = view.phase !== "idle" && view.phase !== "downloading";
  const preview = view.preview;
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const ownerDraft = useMemo(() => ({ text: "" }), [owner]);
  ownerDraft.text = draft;
  const baseSelection = useRef<DictationSelection | null>(null);
  /** The words as they were under a dictation preview, to come back to if it is cancelled. */
  const dictationBase = useRef<ComposerSnapshot | null>(null);
  const waitingSend = useRef(false);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const currentlyHidden = useRef(hidden);
  currentlyHidden.current = hidden;
  useEffect(() => {
    if (hidden) dictation?.leave(owner);
    return () => dictation?.leave(owner);
  }, [dictation, owner, hidden]);

  const [quote, setQuote] = useState<ComposerQuote | null>(saved?.quote ?? null);
  const context = placeContext?.context ?? null;
  const freezeContext = useEffectEvent(() => context?.freeze());
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLButtonElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestingStop, setRequestingStop] = useState(false);
  const stopping = requestingStop || runStopping;
  const [error, setError] = useState<string | null>(saved?.refusal ?? null);
  const [draftUnsaved, setDraftUnsaved] = useState(false);
  const sending = nothingSending;
  const [dropping, setDropping] = useState(false);
  const submittingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const editorRef = useRef<ComposerEditorControl | null>(null);
  /** The editable element: where focus goes back to. */
  const fieldRef = useRef<HTMLElement | null>(null);
  const microphoneRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const mic = microphoneRef.current;
    if (mic?.disabled && document.activeElement === mic) editorRef.current?.focus();
  }, [view.phase, view.blocked, disabled, readOnly]);
  const displayedText = preview?.text ?? draft;
  const adoptEdit = (value: string) => {
    latestDraft.current = value;
    setDraft(value);
    // Words typed over a dictation preview keep it: it is no longer something to undo.
    dictationBase.current = null;
    if (dictating) dictation?.release(owner);
    else if (view.notice) dictation?.dismissNotice();
  };
  // Dictation shows its words as they come, outside the undo history, with the
  // caret after them; the caret is the person's again until the words change.
  // Cancelling puts back exactly what was there.
  const latestPreview = useRef(preview);
  latestPreview.current = preview;
  const previewText = preview?.text ?? null;
  useLayoutEffect(() => {
    const editor = editorRef.current;
    const shown = latestPreview.current;
    if (!editor) return;
    if (shown) {
      dictationBase.current ??= editor.readSnapshot();
      editor.preview({ ...dictationBase.current, text: shown.text, selection: shown.selection });
      return;
    }
    const base = dictationBase.current;
    dictationBase.current = null;
    if (base) editor.restore(base);
  }, [previewText]);
  const readSelection = (): DictationSelection =>
    editorRef.current?.readSnapshot().selection ?? {
      start: latestDraft.current.length,
      end: latestDraft.current.length,
    };
  const startDictation = () => {
    if (!dictation || dictation.getSnapshot().phase !== "idle") return;
    performance.mark("dictation-press");
    baseSelection.current = readSelection();
    editorRef.current?.focus();
    dictation.start({
      owner,
      read: () => ({ text: ownerDraft.text, selection: readSelection() }),
      commit: (text, selection) => {
        const before = ownerDraft.text;
        ownerDraft.text = text;
        // Recognition finished after leaving: the words still belong to this
        // draft, and any written there since stay.
        if (!mounted.current) {
          if (draftKey)
            composerDrafts.handBack(draftKey, {
              edit: (current) =>
                current === before || !current.trim() ? text : `${text}\n${current}`,
            });
          return;
        }
        if (currentOwner.current !== owner) return;
        latestDraft.current = text;
        const editor = editorRef.current;
        const base = dictationBase.current;
        dictationBase.current = null;
        if (!editor) {
          setDraft(text);
          return;
        }
        // The words that were there, then one undoable step to the dictated text.
        if (base) editor.restore(base);
        editor.replace({ start: 0, end: base?.text.length ?? before.length }, text, {
          historyGroup: "dictation",
        });
        editor.setSelection(selection);
      },
    });
  };
  const cancelDictation = () => {
    editorRef.current?.focus();
    if (view.phase === "downloading") {
      dictation?.cancel(owner);
      return;
    }
    const selection = baseSelection.current;
    dictation?.cancel(owner);
    if (selection) {
      const base = dictationBase.current;
      dictationBase.current = null;
      if (base) editorRef.current?.restore({ ...base, selection });
      else editorRef.current?.setSelection(selection);
    }
  };
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const appliedRestore = useRef<ComposerRestore | null>(null);
  const blockedById = useId();
  const staged = useStagedAttachments(attachments);
  const restoreAttachments = staged.restore;
  const acceptsFiles = attachments !== null && !disabled && !readOnly && sendBlocked === null;

  useEffect(() => {
    if (!restore || appliedRestore.current === restore) return;
    appliedRestore.current = restore;
    setDraft((current) =>
      restore.text ? (current.trim() ? `${restore.text}\n${current}` : restore.text) : current,
    );
    if (restore.places) context?.restore(restore.places);
    // Words, a quote or files handed in are the draft changing: the page it
    // follows freezes as it is.
    else if (restore.text || restore.quote || restore.attachments?.length) freezeContext();
    if (restore.attachments) restoreAttachments(restore.attachments);
    // A restore that carries no quote is not a reason to drop the one already
    // standing above the field; only an explicit null takes it away.
    if (restore.quote !== undefined) setQuote(restore.quote);
    const frame = requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      const end = editor.readSnapshot().text.length;
      editor.setSelection({ start: end, end });
    });
    return () => cancelAnimationFrame(frame);
  }, [context, restore, restoreAttachments]);

  const uploadsPending = staged.items.some((item) => item.part === null);
  const chips = context?.chips ?? [];
  // A place the draft picked up by itself does not make a message on its own.
  const explicitPlaces = chips.some((chip) => !chip.auto);
  // A place picked a moment ago is still being read; the message waits for it.
  const placesPending = context?.pending ?? false;
  const hasContent =
    displayedText.trim().length > 0 || dictating || staged.items.length > 0 || explicitPlaces;
  const canSend =
    !disabled &&
    !readOnly &&
    !submitting &&
    hasContent &&
    !uploadsPending &&
    !placesPending &&
    sendBlocked === null;

  const holding = hasContent || quote !== null || submitting;
  const reportHolding = useEffectEvent((value: boolean) => onHoldingChange?.(value));
  useEffect(() => {
    reportHolding(holding);
  }, [holding]);

  const receiveReturned = useRef((_returned: ReturnedToDraft) => {});
  receiveReturned.current = ({ edit, places, quote: returnedQuote, reason, files }) => {
    if (files) restoreAttachments(files.flatMap((file) => (file.part ? [file.part] : [])));
    setDraft(edit);
    if (places?.length) context?.prepend(places);
    if (returnedQuote) setQuote(returnedQuote);
    if (reason) setError(reason);
  };
  useEffect(
    () =>
      draftKey
        ? composerDrafts.open(draftKey, (returned) => receiveReturned.current(returned))
        : undefined,
    [draftKey],
  );
  // A place the draft only picked up by itself is not worth keeping a draft for.
  const keepDraft = hasContent || quote !== null;
  const followingPlace = context?.following ?? true;
  useEffect(() => {
    if (!draftKey) return;
    const kept = composerDrafts.update(
      draftKey,
      keepDraft
        ? {
            quote,
            text: draft,
            ...(followingPlace || !context ? {} : { places: context.parts() }),
          }
        : { places: [], quote: null, text: "" },
    );
    setDraftUnsaved(!kept);
  }, [chips, context, draft, draftKey, followingPlace, keepDraft, quote]);

  const submit = async (
    text = latestDraft.current,
    choice?: import("@opensteer/core").CompactionSendChoice,
  ) => {
    const body = text.trim();
    const carried = staged.items;
    if (disabled || readOnly || submittingRef.current || !canSend) return;
    if (!body && carried.length === 0 && !explicitPlaces) return;
    // Words never go on without the files meant to travel with them.
    const parts = carried.flatMap((item) => (item.part ? [item.part] : []));
    if (parts.length !== carried.length) return;
    const carriedQuote = quote;
    const saved = draftKey?.includes(":task:") ? composerDrafts.read(draftKey) : undefined;
    const places = context?.parts() ?? [];
    const submission: PendingSubmission = {
      ...(choice || compactionOffer?.visible ? { compaction: choice ?? "compactFirst" } : {}),
      attachments: parts,
      body,
      ...(places.length > 0 ? { places } : {}),
      idempotencyKey: mutationIdempotencyKey("message"),
      ...(carriedQuote ? { quotedMessageId: carriedQuote.messageId } : {}),
    };
    {
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const result = await onSend(submission.body, {
          attachments: submission.attachments,
          places: submission.places ?? [],
          ...(submission.compaction ? { compaction: submission.compaction } : {}),
          idempotencyKey: submission.idempotencyKey,
          ...(submission.quotedMessageId ? { quotedMessageId: submission.quotedMessageId } : {}),
        });
        if (
          draftKey &&
          saved !== undefined &&
          (latestDraft.current !== text || !composerDrafts.matches(draftKey, saved))
        ) {
          if (result) composerDrafts.finishTaskStart(draftKey, result.draftGeneration);
          return;
        }
        setDraft((current) => (current.trim() === text.trim() ? "" : current));
        setQuote((current) => (current === carriedQuote ? null : current));
        staged.release(carried.map((item) => item.localId));
        if (JSON.stringify(context?.parts() ?? []) === JSON.stringify(places)) context?.reset();
        if (draftKey && latestDraft.current.trim() === text.trim())
          composerDrafts.update(draftKey, { text: "", places: [], quote: null });
        if (draftKey && result) composerDrafts.finishTaskStart(draftKey, result.draftGeneration);
        if (choice === "keepFullHistory") compactionOffer?.dismiss();
      } catch (error) {
        const issue = clientIssue(error, { operation: "action", label: "save this message" });
        const reason =
          failureWords(error) ??
          (issue && !isNotDone(error) ? presentClientIssue(issue).title : null);
        if (mounted.current) setError(reason);
        else if (draftKey)
          composerDrafts.handBack(draftKey, {
            edit: (current) => {
              if (!body || current.trim() === body) return current;
              return current.trim() ? `${body}\n${current}` : body;
            },
            places,
            quote: carriedQuote,
            ...(reason ? { reason } : {}),
          });
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
      return;
    }
  };

  const latestSubmit = useRef(submit);
  latestSubmit.current = submit;
  const finishAndSend = async (choice?: import("@opensteer/core").CompactionSendChoice) => {
    if (waitingSend.current) return;
    waitingSend.current = true;
    try {
      if (!dictating) {
        // What the field holds now, including input the browser has not yet reported.
        const editor = editorRef.current;
        const typed = editor
          ? await editor.flushPendingInput(editor.readSnapshot().generation).catch(() => null)
          : null;
        if (typed?.composing) return;
        await latestSubmit.current(typed?.text ?? latestDraft.current, choice);
        return;
      }
      const finish = dictation ? await dictation.stop(owner) : { kind: "idle" as const };
      if (
        !mounted.current ||
        currentlyHidden.current ||
        currentOwner.current !== owner ||
        finish.kind === "failed" ||
        finish.kind === "aborted"
      )
        return;
      await latestSubmit.current(
        finish.kind === "committed" ? finish.text : latestDraft.current,
        choice,
      );
    } finally {
      waitingSend.current = false;
    }
  };

  const stop = useCallback(async () => {
    if (!onStop || stopping || disabled || readOnly) return;
    setRequestingStop(true);
    try {
      await onStop();
    } finally {
      setRequestingStop(false);
    }
  }, [onStop, stopping, disabled, readOnly]);

  const allPlaces = context?.places ?? noPlaces;
  const picker = useReferencePicker({
    editor: editorRef,
    field: fieldRef,
    hostClient: placeContext?.hostClient ?? null,
    links: references,
    places: placeContext ? (query) => pickablePlaces(allPlaces, query) : null,
    onPick: (row) => {
      context?.freeze();
      if (row.kind === "place") pickPlace(row.place);
    },
  });

  const pickPlace = (place: PlaceItem) => {
    if (!context) return;
    void context.add(place);
    editorRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (picker.keyDown(event)) return true;
    if (event.key === "Enter" && !event.shiftKey) {
      void finishAndSend();
      return true;
    }
    if (event.key === "Escape" && dictating) {
      event.stopPropagation();
      void dictation?.stop(owner);
      return true;
    }
    if (event.key === "Escape" && onEscape) {
      onEscape();
      return true;
    }
    return false;
  };

  const handlePaste = (event: ClipboardEvent): boolean => {
    if (attachments === null) return false;
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return false;
    // A copied file also puts its name on the clipboard as text; the file is
    // what was meant.
    if (acceptsFiles) {
      context?.freeze();
      staged.add(files);
    }
    return true;
  };

  const handleChange = (text: string, change: ComposerChange) => {
    if (change === "api") {
      latestDraft.current = text;
      setDraft(text);
      return;
    }
    adoptEdit(text);
    context?.freeze();
  };

  const carriesFiles = (event: DragEvent<HTMLDivElement>) =>
    attachments !== null && event.dataTransfer.types.includes("Files");

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    // Claimed even when the composer cannot take them, so a missed drop never
    // navigates away from the draft to open the file.
    event.preventDefault();
    event.dataTransfer.dropEffect = acceptsFiles ? "copy" : "none";
    if (acceptsFiles) setDropping(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      return;
    setDropping(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    if (acceptsFiles) {
      context?.freeze();
      staged.add([...event.dataTransfer.files]);
    }
  };

  const removeAttachment = (localId: string) => {
    staged.remove(localId);
    editorRef.current?.focus();
  };

  const fittedPlaceholder = useFittedPlaceholder(
    fieldRef,
    recipient,
    contextThing(chips),
    placeholder,
  );

  const showStop = running && onStop !== undefined;
  // Sent while a turn runs, work waits in its queue; in a conversation the
  // message joins the reply under way, so it is simply sent.
  const queues = running && variant === "work";
  // While a turn runs the slot belongs to Stop; the send arrow comes back the
  // moment there is something to queue, so a reader is never left without
  // either control.
  // Until an AI is chosen, choosing one is the composer's primary action; the
  // draft can still be written meanwhile.
  const showSend = !settingsRequired && (!showStop || hasContent);
  const blockedBy =
    sendBlocked ??
    (staged.items.some((item) => item.status === "failed")
      ? "Remove or retry the attachments that could not be uploaded"
      : staged.items.some((item) => item.status === "waiting")
        ? filesWaitLine
        : uploadsPending || placesPending
          ? "Waiting for attachments to finish uploading"
          : null);

  const attachable = !disabled && !readOnly;
  const attachmentControl =
    attachments !== null || placeContext !== null ? (
      <>
        <button
          aria-expanded={placeContext ? attachOpen : undefined}
          aria-haspopup={placeContext ? "menu" : undefined}
          aria-label={placeContext ? "Attach" : "Attach files"}
          className="composer__attach"
          disabled={placeContext ? !attachable : !acceptsFiles}
          onClick={() => {
            if (placeContext) setAttachOpen((open) => !open);
            else fileInputRef.current?.click();
          }}
          ref={attachRef}
          title={placeContext ? "Attach a tab or files" : "Attach files"}
          type="button"
        >
          <Icon name="plus" />
        </button>
        {attachOpen && placeContext && attachRef.current ? (
          <AttachMenu
            anchor={attachRef.current}
            hostClient={placeContext.hostClient}
            onClose={() => setAttachOpen(false)}
            onFiles={acceptsFiles ? () => fileInputRef.current?.click() : null}
            onPick={pickPlace}
            places={allPlaces}
          />
        ) : null}
        <input
          aria-hidden
          hidden
          multiple
          onChange={(event) => {
            context?.freeze();
            staged.add([...(event.target.files ?? [])]);
            // Choosing the same file again is a second attachment, not no change.
            event.target.value = "";
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
      </>
    ) : null;

  // While voice holds the microphone, dictation steps aside.
  const microphone =
    view.visible && !onCall ? (
      <button
        ref={microphoneRef}
        className="composer__attach"
        type="button"
        aria-label={dictationStartLabel(view.languageName ?? "")}
        title={dictationLabels.dictate}
        disabled={disabled || readOnly || view.blocked || view.phase !== "idle"}
        // The press is the start: the bar shows on pointer-down, not on release.
        onPointerDown={(event) => {
          if (event.button === 0) {
            event.preventDefault();
            startDictation();
          }
        }}
        onClick={(event) => {
          if (event.detail === 0) startDictation();
        }}
      >
        <Icon name="microphone" />
      </button>
    ) : null;
  const picks = placeContext !== null || references !== null;
  const shown = useMemo(() => shownText(displayedText), [displayedText]);
  const field = (
    <ComposerEditor
      autoFocus={autoFocus === true}
      className="composer__input"
      fieldAttributes={{
        "aria-label": "Message",
        "aria-autocomplete": picks ? "list" : undefined,
        "aria-controls": picker.expanded ? "composer-mention-list" : undefined,
        "aria-expanded": picks ? String(picker.expanded) : undefined,
        "data-composer-input": "",
        "data-fold": variant === "conversation" ? String(composerFold.field) : undefined,
        // Beside its controls, the field needs room for what it shows on one
        // line: its plain placeholder, or the words being written. Without that
        // room it moves above the controls rather than be squeezed. The "about
        // this page" form shows only where it fits; the attached page says the same.
        "data-fold-text":
          variant === "conversation"
            ? shown || placeholderFloor(recipient, placeholder)
            : undefined,
      }}
      fieldRef={(element) => {
        fieldRef.current = element;
        if (inputRef) inputRef.current = element;
      }}
      onBlur={picker.close}
      onChange={handleChange}
      onCompositionStart={() =>
        adoptEdit(editorRef.current?.readSnapshot().text ?? latestDraft.current)
      }
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onSelectionChange={picker.read}
      placeholder={fittedPlaceholder}
      readOnly={readOnly}
      ref={editorRef}
      scope="personal"
      value={draft}
    />
  );
  // One toolbar on every composer: Attach, the AI's settings (or dictation's
  // live bar in their place), then the microphone, Stop and Send at the end.
  const footer = (
    <>
      {view.phase !== "idle" && dictation ? (
        <DictationLive
          controller={dictation}
          view={view}
          onCancel={cancelDictation}
          onStop={() => void dictation.stop(owner)}
          returnFocusTo={fieldRef}
        />
      ) : (
        <>
          {attachmentControl}
          <FoldRow className="composer__settings">{footerExtras}</FoldRow>
        </>
      )}
      {/* Voice and dictation share the microphone: each steps aside for the other. */}
      {view.phase === "idle" ? voice : null}
      {view.phase === "idle" ? microphone : null}
      {showStop ? (
        <StopButton
          disabled={stopping || disabled || readOnly}
          label={stopLabel}
          onStop={() => void stop()}
          returnFocusTo={fieldRef}
        />
      ) : null}
      {showSend ? (
        <button
          aria-label={
            compactionOffer?.visible ? "Summarize and send" : queues ? "Queue message" : sendLabel
          }
          aria-describedby={blockedBy ? blockedById : undefined}
          className="composer__send"
          disabled={!canSend}
          onClick={() => void finishAndSend()}
          title={
            blockedBy ??
            (compactionOffer?.visible ? "Summarize and send" : queues ? "Queue message" : sendLabel)
          }
          type="button"
        >
          <Icon name="send" />
        </button>
      ) : null}
      {blockedBy ? (
        <span className="visually-hidden" id={blockedById}>
          {blockedBy}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={[
        "composer",
        variant === "conversation" ? "composer--conversation" : "",
        dropping ? "composer--dropping" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || picker.open) return;
        if (event.key === "Escape" && dictating) {
          event.preventDefault();
          event.stopPropagation();
          editorRef.current?.focus();
          void dictation?.stop(owner);
        }
      }}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {dictation ? (
        <DictationStatus
          controller={dictation}
          snapshot={speech}
          owner={owner}
          returnFocusTo={fieldRef}
        />
      ) : null}
      {compactionOffer?.visible ? (
        <div className="composer__notice" role="status">
          <p>{compactionOfferText}</p>
          <button
            className="btn btn--small btn--primary"
            type="button"
            disabled={!canSend}
            onClick={() => void finishAndSend("compactFirst")}
          >
            Summarize and send
          </button>
          <button
            className="btn btn--small"
            type="button"
            disabled={!canSend}
            onClick={() => void finishAndSend("keepFullHistory")}
          >
            Send with full history
          </button>
        </div>
      ) : null}
      {sendBlocked !== null && !settingsRequired ? (
        <p className="composer__notice" role="status">
          {sendBlocked}
        </p>
      ) : null}
      {quote ? (
        <section aria-label="Quoted message" className="composer-quote">
          <span className="composer-quote__mark" aria-hidden>
            <Icon name="message" />
          </span>
          <span className="composer-quote__text">
            <span className="composer-quote__attribution">{quote.attribution}</span>
            <span className="composer-quote__excerpt">{quote.excerpt}</span>
          </span>
          <button
            aria-label="Remove quote"
            className="icon-btn icon-btn--small"
            onClick={() => {
              setQuote(null);
              editorRef.current?.focus();
            }}
            title="Remove quote"
            type="button"
          >
            <Icon name="close" />
          </button>
        </section>
      ) : null}
      {attachments !== null ? (
        <AttachmentTray
          disabled={disabled || readOnly}
          items={staged.items}
          notice={staged.notice}
          onDismissNotice={staged.dismissNotice}
          onRemove={removeAttachment}
          onRetry={staged.retry}
          sending={sending}
        />
      ) : null}
      {draftUnsaved ? (
        <p className="composer__error" role="status">
          <Icon name="alert-circle" />
          <span>This draft is not being saved. It stays here until this window closes.</span>
        </p>
      ) : null}
      {error ? (
        <p aria-live="assertive" className="composer__error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      {context && placeContext && chips.length > 0 ? (
        <ContextChips
          chips={chips}
          hostClient={placeContext.hostClient}
          onRemove={(key) => {
            context.remove(key);
            editorRef.current?.focus();
          }}
        />
      ) : null}
      {context?.error ? (
        <p className="composer__error" role="alert">
          <Icon name="alert-circle" />
          <span>{context.error}</span>
        </p>
      ) : null}
      {variant === "conversation" ? (
        // Chat's field sits between Attach and the controls while what it
        // shows fits there whole; otherwise it is the first thing the line
        // gives up, and takes the whole width above the controls.
        <FoldToFit className="composer__entry">
          {picker.list}
          {field}
          <div className="composer__footer">{footer}</div>
        </FoldToFit>
      ) : (
        <div className="composer__entry">
          {picker.list}
          {field}
          <FoldToFit className="composer__footer">{footer}</FoldToFit>
        </div>
      )}
    </div>
  );
}

/**
 * Stop, which leaves once the run it stops has ended: focus that was on it
 * goes back to the words, never to the page body.
 */
function StopButton({
  disabled,
  label,
  onStop,
  returnFocusTo,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onStop: () => void;
  readonly returnFocusTo: { readonly current: HTMLElement | null };
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const fallback = useRef(() => returnFocusTo.current);
  useFocusRescue(ref, fallback);
  return (
    <button
      aria-label={label}
      className="composer__stop"
      disabled={disabled}
      onClick={onStop}
      ref={ref}
      title="Stop"
      type="button"
    >
      <Icon name="stop" />
    </button>
  );
}

/** The words as the field shows them, each reference as its label: what the line must fit. */
function shownText(text: string): string {
  if (!text.includes("](")) return text;
  let shown = "";
  let at = 0;
  for (const token of collectComposerTokens(text, { commitTrailing: true })) {
    shown += `${text.slice(at, token.start)}${token.label}  `;
    at = token.end;
  }
  return shown + text.slice(at);
}

/** What the draft's first place is, for the field to ask about. */
function contextThing(chips: readonly ContextChip[]): "app" | "page" | "phone" | null {
  const first = chips[0];
  if (!first) return null;
  const kind = first.part?.type ?? null;
  if (kind === "computer-app" || (kind === null && first.icon.kind === "app")) return "app";
  if (kind === "phone" || (kind === null && first.icon.kind === "phone")) return "phone";
  return "page";
}

/**
 * A recipient's name keeps this many characters in the field's room, as a
 * model's name does in the execution control: "Opensteer" whole, a long task
 * title its opening words.
 */
const recipientNameFloor = 9;

/** The placeholder the field keeps room for beside a conversation's controls. */
function placeholderFloor(recipient: ComposerRecipient | null, placeholder: string): string {
  if (!recipient) return placeholder;
  const letters = [...recipient.name];
  return `${recipient.lead} ${letters.slice(0, recipientNameFloor).join("").trimEnd()}…`;
}

/**
 * The placeholder, measured against the field so it never wraps or clips: a
 * recipient's "about this page" form only when it fits whole, else the plain
 * form, else the name shortened until "Reply to Friday din…" fits, down to the
 * lead alone ("Ask…"). Without a recipient, the given words, shortened the
 * same way. With no room for even that, no placeholder at all.
 */
function useFittedPlaceholder(
  fieldRef: { readonly current: HTMLElement | null },
  recipient: ComposerRecipient | null,
  thing: "app" | "page" | "phone" | null,
  fallback: string,
): string {
  const [room, setRoom] = useState<{ readonly font: string; readonly width: number } | null>(null);
  const lead = recipient?.lead ?? null;
  const name = recipient?.name ?? null;
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const measure = (fresh: boolean) => {
      // A field that is not laid out (hidden, or a test DOM) has no room to
      // measure, which is not the same as having none.
      if (field.getClientRects().length === 0) {
        setRoom(null);
        return;
      }
      const style = getComputedStyle(field);
      const font = canvasFont(style);
      const width =
        field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setRoom((current) =>
        !fresh && current?.font === font && current.width === width ? current : { font, width },
      );
    };
    measure(false);
    // A web font keeps the font's name but not its widths: the text has to
    // be measured again once it arrives.
    const remeasure = () => measure(true);
    const fonts = "fonts" in document ? document.fonts : null;
    fonts?.addEventListener("loadingdone", remeasure);
    const stopResize =
      typeof ResizeObserver === "undefined" ? null : observeResize([field], () => measure(false));
    return () => {
      fonts?.removeEventListener("loadingdone", remeasure);
      stopResize?.();
    };
  }, [fieldRef]);
  return useMemo(() => {
    const fits = (text: string) => {
      if (!room) return true;
      const width = textWidth(room.font, text);
      return width === null || width <= room.width;
    };
    const about = lead !== null && thing ? `${lead} ${name} about this ${thing}…` : null;
    const plain = lead !== null ? `${lead} ${name}…` : fallback;
    if (about && fits(about)) return about;
    if (fits(plain)) return plain;
    // The name, or the words themselves, give way a character at a time
    // behind one ellipsis; a recipient's lead stays whole.
    const prefix = lead !== null ? `${lead} ` : "";
    const letters = [...(name ?? fallback.replace(/…$/u, ""))];
    const shortened = (count: number) =>
      `${(prefix + letters.slice(0, count).join("")).trimEnd()}…`;
    let low = lead !== null ? 0 : 1;
    let high = letters.length - 1;
    let best: number | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(shortened(middle))) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return best === null ? "" : shortened(best);
  }, [fallback, lead, name, room, thing]);
}

/**
 * What the draft carries beside its words: each place as its picture (taken
 * once) or mark, its name, and a way to take it off.
 */
function ContextChips({
  chips,
  hostClient,
  onRemove,
}: {
  readonly chips: readonly ContextChip[];
  readonly hostClient: HostClient;
  readonly onRemove: (key: string) => void;
}) {
  return (
    <div className="context-chips" role="group" aria-label="Included with your message">
      <div className="context-chips__row">
        {chips.map((chip) => (
          <span
            aria-busy={chip.pending || undefined}
            className={[
              "context-chip",
              chip.gone ? "context-chip--gone" : "",
              chip.pending ? "context-chip--pending" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={chip.key}
            title={
              chip.site && chip.site !== chip.title ? `${chip.title} — ${chip.site}` : chip.title
            }
          >
            {chip.thumbnail ? (
              <img alt="" className="context-chip__thumb" src={chip.thumbnail} />
            ) : null}
            <PlaceMark hostClient={hostClient} icon={chip.icon} />
            <span className="context-chip__title">{chip.title}</span>
            <button
              aria-label={`Don’t include ${chip.title}`}
              className="context-chip__remove"
              onClick={() => onRemove(chip.key)}
              title="Don’t include"
              type="button"
            >
              <Icon name="close" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
