import {
  dictationLabels,
  dictationView,
  dictationStartLabel,
  type DictationSelection,
} from "@opensteer/client/dictation";
import { DictationStatus, DictationLive, useDictation } from "./dictation.js";
import { useVoice } from "./voice.js";
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
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  placeContentLabel,
  type ArtifactContentPart,
  type ContentPart,
  type PlaceContentPart,
} from "@opensteer/core";
import {
  HostClientRequestError,
  mutationIdempotencyKey,
  type HostClient,
  type PlaceItem,
} from "@opensteer/client/host";
import { AttachmentTray } from "./attachments/attachment-tray.js";
import type { ComposerContext, ContextChip } from "./workspace/composer-context.js";
import {
  AttachMenu,
  MentionList,
  caretLeft,
  mentionListHeight,
  mentionRoom,
  pickablePlaces,
} from "./workspace/place-picker.js";
import { PlaceMark } from "./workspace/place-mark.js";
import { useFocusRescue } from "./workspace/occupant-marks.js";
import {
  useStagedAttachments,
  type AttachmentTarget,
} from "./attachments/use-staged-attachments.js";
import { composerFold, FoldRow, FoldToFit } from "./fold-to-fit.js";
import { Icon } from "./icon.js";
import { textWidth } from "./text-width.js";

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
  /** The places the message includes — pages, Mac apps, phones — as the draft held them. */
  readonly places: readonly PlaceContentPart[];
  /** Exact accepted command content, only when a saved send is sent again. */
  readonly content?: readonly ContentPart[];
  /** Uploaded files, in the order the person added them. */
  readonly attachments: readonly ArtifactContentPart[];
  readonly idempotencyKey: string;
  /** The exact source message this one answers, when the reader quoted one. */
  readonly quotedMessageId?: string;
  /** The same message handed to the Host again, after an attempt that went unanswered. */
  readonly replay: boolean;
}

/**
 * A message handed to the Host and not yet acknowledged: its words, its files
 * and its key, fixed together. Sending it again under that key must be the
 * same message, or it is a second one.
 */
export interface PendingSubmission {
  readonly places?: readonly PlaceContentPart[];
  /** Exact accepted command content, only when a saved send is sent again. */
  readonly content?: readonly ContentPart[];
  readonly attachments: readonly ArtifactContentPart[];
  readonly body: string;
  readonly idempotencyKey: string;
  readonly quotedMessageId?: string;
}

/** Where a Thread's unacknowledged message is kept, so a reload can still finish sending it. */
export interface PendingSends {
  /** Throws when it cannot be kept; such a message is not sent. */
  claim(submission: PendingSubmission): void;
  clear(idempotencyKey: string): void;
  /** Removes whatever is kept, including a record that can no longer be read. */
  discard(): void;
  /** Throws when the kept record cannot be read. */
  read(): PendingSubmission | null;
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
  dictationScope?: string;
  hidden?: boolean;
  variant?: "conversation" | "work";
  /**
   * No AI is chosen yet: the footer's "Choose AI" is the primary action, so
   * the send button stays away until there is something to send with.
   */
  settingsRequired?: boolean;
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
   * Published so a surface that took the keyboard away — the AI picker's
   * review, a Find panel — can give it back to the words being written.
   */
  inputRef?: React.RefObject<HTMLTextAreaElement | null> | undefined;
  /**
   * Reports the draft as it is written, for a surface that has to keep it
   * alive across a change of route — Home's composer becoming the Home
   * conversation's composer, for instance.
   */
  onDraftChange?: ((draft: string) => void) | undefined;
  /**
   * Whether anything is in this composer: words, files, a quote, or a send
   * still in flight. A surface that another route may replace asks for this
   * before it takes the composer away.
   */
  onHoldingChange?: ((holding: boolean) => void) | undefined;
  /** Invoked when the reader presses Escape in the textarea (e.g. to return focus to docked action options). */
  onEscape?: (() => void) | undefined;
  onSend: (body: string, submission: ComposerSubmission) => Promise<void>;
  onStop?: (() => Promise<void>) | undefined;
  /**
   * Keeps each message before it is sent, and a message whose send went
   * unanswered apart from the draft, to be sent again exactly. Without it
   * `onSend` is responsible for keeping what it sends, and a failed send
   * returns to the draft.
   */
  pendingSends?: PendingSends | null | undefined;
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
  disabled = false,
  readOnly = false,
  footerExtras,
  voice,
  inputRef,
  onDraftChange,
  onHoldingChange,
  onEscape,
  onSend,
  onStop,
  pendingSends = null,
  placeholder,
  recipient = null,
  restore = null,
  running = false,
  sendBlocked = null,
  sendLabel = "Send message",
  stopLabel = "Stop the run",
  stopping: runStopping = false,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const { controller: dictation, snapshot: speech } = useDictation();
  const { snapshot: voiceState } = useVoice();
  const instance = useId();
  const owner = `${dictationScope}/${instance}`;
  const view = dictationView(speech, owner);
  const dictating = view.phase !== "idle" && view.phase !== "downloading";
  const preview = view.preview;
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const ownerDraft = useMemo(() => ({ text: "" }), [owner]);
  ownerDraft.text = draft;
  const pendingSelection = useRef<DictationSelection | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const baseSelection = useRef<DictationSelection | null>(null);
  const waitingSend = useRef(false);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const currentlyHidden = useRef(hidden);
  currentlyHidden.current = hidden;
  useEffect(() => {
    if (hidden) dictation?.leave(owner);
    return () => dictation?.leave(owner);
  }, [dictation, owner, hidden]);

  const [quote, setQuote] = useState<ComposerQuote | null>(null);
  const context = placeContext?.context ?? null;
  const freezeContext = useEffectEvent(() => context?.freeze());
  // `@` typed at a word start: where it began, what follows it, the row chosen.
  const [mention, setMention] = useState<{
    readonly active: number;
    /** No room for the list above the words: it opens below them. */
    readonly below: boolean;
    readonly left: number;
    readonly query: string;
    readonly start: number;
  } | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLButtonElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestingStop, setRequestingStop] = useState(false);
  const stopping = requestingStop || runStopping;
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(nothingSending);
  const [dropping, setDropping] = useState(false);
  const [held, setHeld] = useState(() => ({ owner: pendingSends, ...readHeld(pendingSends) }));
  const submittingRef = useRef(false);
  /** False once this composer is gone; see the refusal branch of `deliver`. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const microphoneRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const mic = microphoneRef.current;
    if (mic?.disabled && document.activeElement === mic) textareaRef.current?.focus();
  }, [view.phase, view.blocked, disabled, readOnly]);
  const displayedText = preview?.text ?? draft;
  const adoptEdit = (value: string) => {
    latestDraft.current = value;
    setDraft(value);
    if (dictating) dictation?.release(owner);
    else if (view.notice) dictation?.dismissNotice();
  };
  const startDictation = () => {
    if (!dictation) return;
    const field = textareaRef.current;
    baseSelection.current = {
      start: field?.selectionStart ?? draft.length,
      end: field?.selectionEnd ?? draft.length,
    };
    field?.focus();
    dictation.start({
      owner,
      read: () => ({
        text: ownerDraft.text,
        selection: {
          start: textareaRef.current?.selectionStart ?? latestDraft.current.length,
          end: textareaRef.current?.selectionEnd ?? latestDraft.current.length,
        },
      }),
      commit: (text, selection) => {
        ownerDraft.text = text;
        if (currentOwner.current !== owner) return;
        latestDraft.current = text;
        pendingSelection.current = selection;
        setSelectionVersion((version) => version + 1);
        setDraft(text);
      },
    });
  };
  const cancelDictation = () => {
    textareaRef.current?.focus();
    if (view.phase === "downloading") {
      dictation?.cancel(owner);
      return;
    }
    pendingSelection.current = baseSelection.current;
    dictation?.cancel(owner);
    setSelectionVersion((version) => version + 1);
  };
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const appliedRestore = useRef<ComposerRestore | null>(null);
  /** The pending key already tried on this connection, so a reload retries once, not in a loop. */
  const attempted = useRef<string | null>(null);
  const blockedById = useId();
  const staged = useStagedAttachments(attachments);
  const restoreAttachments = staged.restore;
  const acceptsFiles = attachments !== null && !disabled && !readOnly && sendBlocked === null;

  // Another Thread, user or deployment has its own unacknowledged message, if any.
  let current = held;
  if (held.owner !== pendingSends) {
    current = { owner: pendingSends, ...readHeld(pendingSends) };
    setHeld(current);
  }
  const pending = current.value;
  const unreadable = current.unreadable;

  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, []);

  useLayoutEffect(() => {
    const selection = preview?.selection ?? pendingSelection.current;
    if (selection) textareaRef.current?.setSelectionRange(selection.start, selection.end);
    pendingSelection.current = null;
    resize();
  }, [displayedText, selectionVersion, resize]);

  const reportDraft = useEffectEvent((value: string) => onDraftChange?.(value));
  useEffect(() => {
    reportDraft(draft);
  }, [draft]);

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
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
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
    pending === null &&
    unreadable === null &&
    sendBlocked === null;

  const holding =
    hasContent || quote !== null || submitting || pending !== null || unreadable !== null;
  const reportHolding = useEffectEvent((value: boolean) => onHoldingChange?.(value));
  useEffect(() => {
    reportHolding(holding);
  }, [holding]);

  /**
   * One attempt. `carried` names the tray files this attempt took; an attempt
   * from the held message has none there.
   */
  const deliver = async (
    submission: PendingSubmission,
    replay: boolean,
    carried: readonly string[],
    carriedQuote: ComposerQuote | null = null,
  ): Promise<void> => {
    const owner = pendingSends;
    const hold = (value: PendingSubmission | null) =>
      setHeld((previous) =>
        previous.owner === owner ? { owner, unreadable: null, value } : previous,
      );
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSend(submission.body, {
        attachments: submission.attachments,
        places: submission.places ?? [],
        ...(submission.content ? { content: submission.content } : {}),
        idempotencyKey: submission.idempotencyKey,
        ...(submission.quotedMessageId ? { quotedMessageId: submission.quotedMessageId } : {}),
        replay,
      });
      forgetPending(owner, submission.idempotencyKey);
      hold(null);
      staged.release(carried);
      textareaRef.current?.focus();
    } catch (sendError) {
      if (owner && unanswered(sendError)) {
        // Held as sent. Only "Send again" sends it, under the same key.
        hold(submission);
        staged.release(carried);
        setError(
          "Opensteer could not confirm this message was sent. Send it again when you are connected.",
        );
        return;
      }
      // Refused after this composer closed: the message stays kept, so the
      // next time this Thread opens it is answered again and handed back to
      // that draft, rather than to no draft at all.
      if (owner && !mounted.current) return;
      // Refused: the Host answered, so the words and files go back to be
      // changed, and whatever is sent next is a new message.
      forgetPending(owner, submission.idempotencyKey);
      hold(null);
      // The places it carried come back with its words, ahead of whatever the
      // next draft holds by now — a recovered send's too.
      context?.prepend(submission.places ?? []);
      const { body } = submission;
      if (body) setDraft((current) => (current.trim() ? `${body}\n${current}` : body));
      if (carried.length === 0) restoreAttachments(submission.attachments);
      // The refused message goes back whole: its quote is part of what was
      // written, and retyping the reference is not something to ask for.
      if (carriedQuote) setQuote(carriedQuote);
      setError(sendError instanceof Error ? sendError.message : "The message could not be sent.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      setSending(nothingSending);
    }
  };

  const submit = async (text = latestDraft.current) => {
    const body = text.trim();
    const carried = staged.items;
    if (disabled || readOnly || submittingRef.current || !canSend) return;
    if (!body && carried.length === 0 && !explicitPlaces) return;
    // Words never go on without the files meant to travel with them.
    const parts = carried.flatMap((item) => (item.part ? [item.part] : []));
    if (parts.length !== carried.length) return;
    const carriedQuote = quote;
    const places = context?.parts() ?? [];
    const submission: PendingSubmission = {
      attachments: parts,
      body,
      ...(places.length > 0 ? { places } : {}),
      idempotencyKey: mutationIdempotencyKey("message"),
      ...(carriedQuote ? { quotedMessageId: carriedQuote.messageId } : {}),
    };
    try {
      pendingSends?.claim(submission);
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : "The message was not kept.");
      return;
    }
    attempted.current = submission.idempotencyKey;
    const ids = carried.map((item) => item.localId);
    setSending(new Set(ids));
    // The message is on its way; what is written now is the next draft, with
    // its own places. Nothing the send answers later reaches back into it.
    setDraft("");
    setQuote(null);
    setMention(null);
    context?.reset();
    await deliver(submission, false, ids, carriedQuote);
  };

  const latestSubmit = useRef(submit);
  latestSubmit.current = submit;
  const finishAndSend = async () => {
    if (waitingSend.current) return;
    waitingSend.current = true;
    try {
      if (!dictating) {
        await latestSubmit.current();
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
      await latestSubmit.current(finish.kind === "committed" ? finish.text : latestDraft.current);
    } finally {
      waitingSend.current = false;
    }
  };

  const sendAgain = async () => {
    if (!pending || disabled || readOnly || submittingRef.current) return;
    attempted.current = pending.idempotencyKey;
    await deliver(pending, true, []);
  };

  const discardUnreadable = () => {
    if (!pendingSends) return;
    try {
      pendingSends.discard();
      setHeld({ owner: pendingSends, ...readHeld(pendingSends) });
    } catch (discardError) {
      setError(
        discardError instanceof Error ? discardError.message : "The saved message was not removed.",
      );
    }
  };

  // A message the page came back holding is sent again once there is a Host
  // to take it; a reconnection is what makes another try worth making.
  const retryHeld = useEffectEvent(() => void sendAgain());
  useEffect(() => {
    if (disabled || readOnly) {
      attempted.current = null;
      return;
    }
    if (pending === null || attempted.current === pending.idempotencyKey) return;
    retryHeld();
  }, [disabled, pending, readOnly]);

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
  const mentionPlaces = mention ? pickablePlaces(allPlaces, mention.query) : [];

  /** The "@query" before the caret, when it starts a word and holds no space. */
  const readMention = (textarea: HTMLTextAreaElement) => {
    if (!placeContext) return;
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    const at = before.lastIndexOf("@");
    const query = at === -1 ? "" : before.slice(at + 1);
    if (at === -1 || /\s/u.test(query) || (at > 0 && !/\s/u.test(before.charAt(at - 1)))) {
      setMention(null);
      return;
    }
    // The list opens at the "@", kept inside the box it opens from.
    const frame = textarea.offsetParent instanceof HTMLElement ? textarea.offsetParent : null;
    const room = frame?.clientWidth ?? 300;
    const left = Math.max(0, Math.min(caretLeft(textarea, at), room - Math.min(300, room)));
    const space = frame ? mentionRoom(frame) : null;
    setMention((current) => ({
      active: current?.start === at ? Math.min(current.active, 99) : 0,
      below: space !== null && space.above < mentionListHeight && space.below > space.above,
      left,
      query,
      start: at,
    }));
  };

  const pickPlace = (place: PlaceItem) => {
    if (!context) return;
    void context.add(place);
    textareaRef.current?.focus();
  };

  const pickMention = (place: PlaceItem) => {
    const textarea = textareaRef.current;
    if (!mention || !textarea) return;
    // The "@" and what followed it were only how the place was found.
    const end = mention.start + 1 + mention.query.length;
    const next = draft.slice(0, mention.start) + draft.slice(end);
    setDraft(next);
    setMention(null);
    pickPlace(place);
    requestAnimationFrame(() => textarea.setSelectionRange(mention.start, mention.start));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (mention && mentionPlaces.length > 0 && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMention({
          ...mention,
          active: (mention.active + step + mentionPlaces.length) % mentionPlaces.length,
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const place = mentionPlaces[mention.active] ?? mentionPlaces[0];
        if (place) pickMention(place);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void finishAndSend();
    } else if (event.key === "Escape" && dictating && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      void dictation?.stop(owner);
    } else if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachments === null) return;
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    // A copied file also puts its name on the clipboard as text; the file is
    // what was meant.
    event.preventDefault();
    if (acceptsFiles) {
      context?.freeze();
      staged.add(files);
    }
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
    textareaRef.current?.focus();
  };

  const fittedPlaceholder = useFittedPlaceholder(
    textareaRef,
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
    (unreadable !== null
      ? "Deal with the saved message that cannot be read first"
      : pending !== null
        ? "Send the unconfirmed message again first"
        : staged.items.some((item) => item.status === "failed")
          ? "Remove or retry the attachments that could not be uploaded"
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
    view.visible && voiceState.phase === "idle" ? (
      <button
        ref={microphoneRef}
        className={`composer__attach ${view.phase === "listening" ? "dictation-stop" : ""}`}
        type="button"
        aria-label={
          view.phase === "listening" || view.phase === "finishing"
            ? dictationLabels.stop
            : dictationStartLabel(view.languageName ?? "")
        }
        title={dictationLabels.dictate}
        disabled={
          disabled ||
          readOnly ||
          view.blocked ||
          (view.phase !== "idle" && view.phase !== "listening")
        }
        onClick={() => {
          textareaRef.current?.focus();
          if (view.phase === "listening") void dictation?.stop(owner);
          else startDictation();
        }}
      >
        {["starting", "finishing", "downloading"].includes(view.phase) ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <Icon name={view.phase === "listening" ? "stop" : "microphone"} />
        )}
      </button>
    ) : null;
  const mentionList =
    mention && placeContext ? (
      <MentionList
        active={mention.active}
        below={mention.below}
        hostClient={placeContext.hostClient}
        left={mention.left}
        onPick={pickMention}
        places={mentionPlaces}
      />
    ) : null;
  const field = (
    <textarea
      ref={(element) => {
        textareaRef.current = element;
        if (inputRef) inputRef.current = element;
      }}
      autoFocus={autoFocus}
      aria-label="Message"
      className="composer__input"
      data-fold={variant === "conversation" ? composerFold.field : undefined}
      // Beside its controls, the field keeps room for its plain placeholder:
      // the controls give up words and pills first. The "about this page"
      // form shows only where it fits; the attached page says the same.
      data-fold-text={
        variant === "conversation" && !dictation
          ? placeholderFloor(recipient, placeholder)
          : undefined
      }
      data-composer-input=""
      readOnly={readOnly}
      aria-autocomplete={placeContext ? "list" : undefined}
      aria-controls={mention && mentionPlaces.length > 0 ? "composer-mention-list" : undefined}
      aria-expanded={placeContext ? mention !== null && mentionPlaces.length > 0 : undefined}
      onBlur={() => setMention(null)}
      onChange={(event) => {
        adoptEdit(event.target.value);
        context?.freeze();
        readMention(event.target);
      }}
      onCompositionStart={(event) => adoptEdit(event.currentTarget.value)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={fittedPlaceholder}
      rows={1}
      value={displayedText}
    />
  );
  const footer = (
    <>
      {variant !== "conversation" ? (
        <>
          {attachmentControl}
          {microphone}
        </>
      ) : null}
      {dictation ? (
        <div className="composer__dictation-slot">
          {dictation && view.phase !== "idle" ? (
            <DictationLive
              controller={dictation}
              view={view}
              onCancel={cancelDictation}
              returnFocusTo={textareaRef}
            />
          ) : (
            <FoldRow className="composer__settings">{footerExtras}</FoldRow>
          )}
        </div>
      ) : (
        <FoldRow className="composer__settings">{footerExtras}</FoldRow>
      )}
      {voice}
      {showStop ? (
        <StopButton
          disabled={stopping || disabled || readOnly}
          label={stopLabel}
          onStop={() => void stop()}
          returnFocusTo={textareaRef}
        />
      ) : null}
      {showSend ? (
        <button
          aria-label={queues ? "Queue message" : sendLabel}
          aria-describedby={blockedBy ? blockedById : undefined}
          className="composer__send"
          disabled={!canSend}
          onClick={() => void finishAndSend()}
          title={blockedBy ?? (queues ? "Queue message" : sendLabel)}
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
        dictation ? "composer--dictation" : "",
        variant === "conversation" ? "composer--conversation" : "",
        dropping ? "composer--dropping" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || mention) return;
        if (event.key === "Escape" && dictating) {
          event.preventDefault();
          event.stopPropagation();
          textareaRef.current?.focus();
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
          returnFocusTo={textareaRef}
        />
      ) : null}
      {sendBlocked !== null && !settingsRequired ? (
        <p className="composer__notice" role="status">
          {sendBlocked}
        </p>
      ) : null}
      {unreadable !== null ? (
        <section aria-label="Saved message" className="held-message" role="alert">
          <p className="held-message__text">{unreadable}</p>
          <div className="held-message__foot">
            <span>Check the conversation: it may already have been sent.</span>
            <button className="btn btn--small" onClick={discardUnreadable} type="button">
              Discard saved message
            </button>
          </div>
        </section>
      ) : pending ? (
        <HeldMessage
          disabled={disabled || readOnly || submitting}
          message={pending}
          onSendAgain={() => void sendAgain()}
          sending={submitting}
        />
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
              textareaRef.current?.focus();
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
            textareaRef.current?.focus();
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
        // Beside its controls the field is one more thing the line fits: its
        // room for the whole placeholder is the last thing given up.
        <FoldToFit className="composer__entry">
          {mentionList}
          {attachmentControl}
          {microphone}
          {field}
          <div className="composer__footer">{footer}</div>
        </FoldToFit>
      ) : (
        <div className="composer__entry">
          {mentionList}
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
  readonly returnFocusTo: { readonly current: HTMLTextAreaElement | null };
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
  textareaRef: { readonly current: HTMLTextAreaElement | null },
  recipient: ComposerRecipient | null,
  thing: "app" | "page" | "phone" | null,
  fallback: string,
): string {
  const [room, setRoom] = useState<{ readonly font: string; readonly width: number } | null>(null);
  const lead = recipient?.lead ?? null;
  const name = recipient?.name ?? null;
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const measure = (fresh: boolean) => {
      // A field that is not laid out (hidden, or a test DOM) has no room to
      // measure, which is not the same as having none.
      if (textarea.getClientRects().length === 0) {
        setRoom(null);
        return;
      }
      const style = getComputedStyle(textarea);
      const width =
        textarea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setRoom((current) =>
        !fresh && current?.font === style.font && current.width === width
          ? current
          : { font: style.font, width },
      );
    };
    measure(false);
    // A web font keeps the font's name but not its widths: the text has to
    // be measured again once it arrives.
    const remeasure = () => measure(true);
    const fonts = "fonts" in document ? document.fonts : null;
    fonts?.addEventListener("loadingdone", remeasure);
    const stopResize =
      typeof ResizeObserver === "undefined"
        ? null
        : observeResize([textarea], () => measure(false));
    return () => {
      fonts?.removeEventListener("loadingdone", remeasure);
      stopResize?.();
    };
  }, [textareaRef]);
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
            <PlaceMark hostClient={hostClient} icon={chip.icon} site={chip.site} />
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

/** The message still owed to the Host, shown as it was sent. */
function HeldMessage({
  disabled,
  message,
  onSendAgain,
  sending,
}: {
  readonly disabled: boolean;
  readonly message: PendingSubmission;
  readonly onSendAgain: () => void;
  readonly sending: boolean;
}) {
  return (
    <section aria-label="Unconfirmed message" className="held-message">
      {(message.places ?? []).map((part, index) => (
        <p className="held-message__text" key={`${part.type}:${index}`}>
          {placeContentLabel(part)}
        </p>
      ))}
      {message.body ? <p className="held-message__text">{message.body}</p> : null}
      {message.attachments.length > 0 ? (
        <ul aria-label="Attachments" className="held-message__files">
          {message.attachments.map((part) => (
            <li key={part.artifactId} title={part.name}>
              <Icon name="paperclip" />
              <span>{part.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="held-message__foot">
        <span role="status">{sending ? "Sending…" : "Not confirmed yet."}</span>
        <button className="btn btn--small" disabled={disabled} onClick={onSendAgain} type="button">
          Send again
        </button>
      </div>
    </section>
  );
}

/**
 * What this Thread still owes the Host. A record that cannot be read is
 * reported rather than read as nothing: it may be a message already sent,
 * and only the person can decide to let it go.
 */
function readHeld(pendingSends: PendingSends | null): {
  readonly unreadable: string | null;
  readonly value: PendingSubmission | null;
} {
  try {
    return { unreadable: null, value: pendingSends?.read() ?? null };
  } catch (error) {
    return {
      unreadable: `A message saved for sending here cannot be read${
        error instanceof Error && error.message ? ` (${error.message})` : ""
      }. Nothing more is sent from this conversation until it is discarded.`,
      value: null,
    };
  }
}

/**
 * The Host has answered, so the record has done its job. Failing to erase it
 * leaves a replay of an answered key, which the Host answers the same way.
 */
function forgetPending(pendingSends: PendingSends | null, idempotencyKey: string): void {
  try {
    pendingSends?.clear(idempotencyKey);
  } catch {
    // The answer stands either way; see above.
  }
}

/** The Host may or may not have taken it: the answer was lost, not a refusal. */
function unanswered(error: unknown): boolean {
  return !(error instanceof HostClientRequestError) || error.status >= 500 || error.status === 408;
}
