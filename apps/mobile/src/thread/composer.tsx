import { useMobileNotifications } from "../ui/notifications-context.js";
import { hostMessageOutbox } from "@opensteer/client/host";
import { clientIssue, presentActionFailure, presentClientIssue } from "@opensteer/client/feedback";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { issueLine } from "../ui/client-feedback.js";
import { notSent, notSentIssue, useConnectionReady } from "../ui/connection-live.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import type { ComposerEditorHandle } from "@opensteer/client/references";
import { ComposerEditor } from "../ui/composer-editor.js";
import {
  activeReferenceQuery,
  ComposerReferencePicker,
  insertReference,
  personalReferenceSections,
  startReference,
} from "../ui/composer-reference-picker.js";
import { useCompactionOffer } from "@opensteer/client/react";
import { compactionOfferText } from "@opensteer/client/host";
import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { useHostSelector } from "@opensteer/client/react";
import { useFocusEffect } from "@react-navigation/native";
import { VoiceDock, VoiceMic } from "../voice/controls.js";
import { useVoiceAvailable, useVoiceOn } from "../voice/use-voice-value.js";
import { useId } from "react";
import { useDictation } from "../dictation/context.js";
import { DictationBar, DictationMic, DictationStatus } from "../dictation/controls.js";
import { dictationLabels, dictationView } from "@opensteer/client/dictation";
import {
  deriveSurface,
  mutationIdempotencyKey,
  type HostClient,
  type UsageLimitNotice,
} from "@opensteer/client/host";
import {
  attachmentMaxBytes,
  attachmentMessageMaxCount,
  type ArtifactContentPart,
  type AuthenticatedUser,
  type BrowserPageContentPart,
  type Request,
  type ModelSelection,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import * as Haptics from "expo-haptics";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Alert,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { pageIdentity } from "../browser/surface-route.js";
import type {
  TaskStartRecord,
  ThreadDraftQuote,
  ThreadDraftStore,
} from "../client/thread-drafts.js";
import { Symbol } from "../ui/symbol.js";
import {
  color,
  material,
  controlFontScaleLimit,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { appear, enter, exit } from "../ui/motion.js";
import { ComposerAction } from "../ui/composer-action.js";
import { AppText } from "../ui/primitives.js";
import { usePaneInView } from "../ui/pane.js";
import { ComposerBar, ComposerGlyph, composerLaneHeight } from "./composer-bar.js";
import { NativeMenu, type NativeMenuOption } from "./composer-menu.js";
import { composerView } from "./composer-model.js";
import { ComposerPills } from "./composer-pills.js";
import { AttachmentStrip } from "./attachment-views.js";
import { attachmentKey, draftAttachmentPart, useDraftAttachments } from "./draft-attachments.js";
import { AnswerBar } from "./answer-bar.js";
import { QuestionRequestCard } from "./question-card.js";
import { RequestCard } from "./request-card.js";
import type { ThreadMutationClaim, ThreadMutationGate } from "./thread-mutation-gate.js";
import { UsageNotice } from "./usage-notice.js";

/**
 * The one surface at the bottom of a Thread: the composer, and whatever
 * Opensteer is currently waiting on, docked into it.
 *
 * The draft is what is being typed and is the person's to change. Send hands
 * the message to the app's outbox, which writes it to this phone before
 * anything goes out and delivers it when the connection is ready, so the bar
 * stays usable offline. The transcript shows each message on its way, where
 * it will stand; nothing about it waits in the bar. Only a failure to write it
 * down here is said beside the bar, and the draft stays.
 */
export function Composer(props: {
  readonly variant?: "conversation" | "work";
  /** What this Thread may do without asking, named in AI settings. */
  readonly accessMode: ThreadAccessMode;
  /** The modes this Thread's engine can enforce, or null while it has not said. */
  readonly accessModes: readonly ThreadAccessMode[] | null;
  /**
   * False while the Host is unreachable. A decision is never queued: its
   * controls stay usable and a tap says it didn't go out.
   */
  readonly canRespond: boolean;
  readonly deploymentId: string;
  /** What stops this Thread accepting anything, in words, or null. */
  readonly disabledReason: string | null;
  /** An archived Thread keeps its transcript; its bar keeps only a sentence. */
  readonly readOnly?: boolean;
  readonly drafts: ThreadDraftStore;
  /** The engine's product name, so a refused access mode says which one refuses it. */
  readonly engineName: string;
  readonly driverKind?: string | undefined;
  readonly executionBlockedReason?: string | null;
  readonly highlightRequestId: string | null;
  readonly hostClient: HostClient;
  /** What the next message will run on, in the words the settings sheet uses. */
  readonly modelLabel: string;
  readonly model: HarnessModelDescriptor | null;
  readonly modelOptions: ModelSelection["options"];
  readonly mutationGate: ThreadMutationGate;
  /**
   * The page the person is looking at, included with the next message unless
   * they remove it. Removing it holds for this message and this page only. A
   * page Ask put on the draft comes first.
   */
  readonly page?: BrowserPageContentPart | null;
  readonly onChangeModel: (conversation?: boolean) => void;
  /** This Thread's own actions, where no title menu carries them. */
  readonly conversationActions: readonly NativeMenuOption[];
  readonly placeholder: string;
  readonly requests: readonly Request[];
  /**
   * Words handed back to the composer, such as a queued message taken back to
   * be reworded. Each new value joins the draft once, ahead of what is there.
   */
  readonly restore?: {
    readonly attachments?: readonly ArtifactContentPart[];
    readonly key: number;
    /** An update to answer; it becomes a removable chip, never draft text. */
    readonly quote?: ThreadDraftQuote | null;
    readonly text: string;
  } | null;
  readonly running: boolean;
  readonly runStopping: boolean;
  /** Names what Stop stops, where more than one thing on screen can be stopped. */
  readonly stopLabel?: string;
  /** Why the model and access settings cannot be changed right now, or null. */
  readonly settingsDisabledReason: string | null;
  readonly threadId: string;
  /** The line under the bar while this Thread's account is out of plan capacity. */
  readonly usageNotice?: UsageLimitNotice | null;
  readonly user: AuthenticatedUser;
  /** Home's composer, which offers the voice button beside the microphone. */
  readonly voice?: boolean;
}): ReactNode {
  const aiSharing = useAiSharing();
  const surface = useMemo(
    () => deriveSurface(props.requests, props.user, props.highlightRequestId),
    [props.highlightRequestId, props.requests, props.user],
  );
  const outbox = hostMessageOutbox(props.hostClient);
  const notifications = useMobileNotifications();
  const { deploymentId, drafts, hostClient, threadId } = props;
  const userId = props.user.id;
  useSyncExternalStore(drafts.subscribe, drafts.getVersion);
  const draft = drafts.readDraft(deploymentId, userId, threadId);
  const text = draft?.text ?? "";
  const dictation = useDictation();
  const dictationState = useSyncExternalStore(dictation.subscribe, dictation.getSnapshot);
  const instance = useId();
  const owner = JSON.stringify([deploymentId, userId, threadId, instance]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const selection = useRef({ start: text.length, end: text.length });
  // The caret, as state only so an `@` it follows opens the reference picker.
  const [caret, setCaret] = useState(text.length);
  const speechView = dictationView(dictationState, owner);
  const preview = speechView.preview;
  const dictating = ["starting", "listening", "finishing"].includes(speechView.phase);
  const displayedText = preview?.text ?? text;
  const visible = useRef(false);
  const inView = usePaneInView();
  useFocusEffect(
    useCallback(() => {
      if (!inView) return;
      visible.current = true;
      return () => {
        visible.current = false;
        dictation.leave(owner);
      };
    }, [dictation, inView, owner]),
  );
  const quote = draft?.quote ?? null;
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  // What Send or Stop came to, beside the bar: a message that couldn't be
  // written down here, or a Stop that didn't go out.
  const [failure, setFailure] = useState<ActionLineValue | null>(null);
  const [draftFailure, setDraftFailure] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const input = useRef<ComposerEditorHandle>(null);
  // Out of view, the field lets go of the keyboard: nothing is typed where it
  // cannot be seen.
  useEffect(() => {
    if (!inView) input.current?.blur();
  }, [inView]);
  const { fontScale } = useWindowDimensions();
  // Roughly six lines at the default text size before the field scrolls inside
  // itself. It is a height rather than a line count because the field's lines
  // are the font's own, and it grows with Dynamic Type as far as they may.
  const fieldMaxHeight =
    type.body.lineHeight * 6 * Math.min(fontScale, controlFontScaleLimit) + fieldPadding * 2;
  /**
   * A menu or a sheet this bar raised is on screen. It takes the field's focus
   * with it, and without this the row holding the control that opened it would
   * leave while the menu was still anchored to it.
   */
  const [presenting, setPresenting] = useState(false);
  const inFlight = useRef(false);
  const stoppingRef = useRef(false);
  const draftText = useRef(text);
  draftText.current = text;
  const draftWrite = useRef(0);
  /** The key already tried while this connection has been up, so a refusal is
   * not retried on a loop. A reconnection is what makes it worth trying again. */
  /** A message the Host refused, on its way back into the draft. */
  const [refused, setRefused] = useState<TaskStartRecord | null>(null);
  /**
   * False once this bar is gone. A refusal that arrives after that leaves the
   * command on the phone, to be answered again and handed back to the draft
   * the next time this Thread is open, rather than to no draft at all.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const staged = useDraftAttachments({
    client: hostClient,
    draftKey: threadId,
    drafts,
    files: { deploymentId, threadId, userId },
  });
  const attachmentsReady = staged.items.every((item) => draftAttachmentPart(item) !== null);
  // Files still on their way hold Send; offline, the bar says why once.
  const connectionReady = useConnectionReady(hostClient.connection);
  const filesWait = !attachmentsReady && !connectionReady && !(props.readOnly ?? false);

  // The page this message includes. One Ask put on the draft is the person's
  // own choice and stays with the draft until it is sent or removed. Otherwise
  // it is the page in front of them, unless they took that page off this
  // message; another page, and the next message, bring it back.
  const draftPage = draft?.page ?? null;
  const offeredPage = props.page ?? null;
  const offeredKey = offeredPage === null ? null : pageIdentity(offeredPage);
  const [declinedPage, setDeclinedPage] = useState<string | null>(null);
  const includedPage =
    draftPage ?? (offeredKey === null || offeredKey === declinedPage ? null : offeredPage);

  // A Host with quiet-tasks-v1 reopens a Done task when it is written to.
  const done = useHostSelector(hostClient, (snapshot) =>
    snapshot.threads.find((thread) => thread.id === threadId)?.doneAt != null
      ? snapshot.quietTasksAvailable === true
        ? "reopens"
        : "closed"
      : null,
  );
  const readOnly = done === "closed" || (props.readOnly ?? false);
  const disabled = props.disabledReason !== null || outbox === null || readOnly;
  const textHidden = surface !== null && surface.textRole === "hidden";
  // A question the viewer can answer turns this bar into its answer field,
  // unless a message is already being written here: that draft keeps the bar
  // until it is sent or emptied, or the person chooses to answer instead.
  const question = surface !== null && surface.textRole === "answer" && !readOnly ? surface : null;
  const holdsDraft = text.trim() !== "" || staged.items.length > 0 || quote !== null;
  const [answerInstead, setAnswerInstead] = useState<string | null>(null);
  const answering = question !== null && (!holdsDraft || answerInstead === question.request.id);
  // Which control the bar shows, and whether its settings row is open, is
  // arithmetic over the state above — including the rule that keeps one message
  // in flight at a time, because a second claim would be a second key for a
  // Thread that has not answered the first.
  const voiceReady = useVoiceAvailable() && props.voice === true;
  const view = composerView({
    attachments: staged.items.length,
    attachmentsReady,
    canRespond: outbox !== null,
    disabledReason: props.disabledReason,
    focused,
    pendingCommand: false,
    presenting,
    readOnly,
    running: props.running,
    sending,
    text: displayedText,
    textHidden,
    voice: voiceReady,
  });
  const canSend = view.canSend || (dictating && !disabled && !sending && attachmentsReady);
  // A typed `@` offers references to put in the words, until the caret leaves it.
  const referenceQuery =
    focused && !dictating && !disabled && !textHidden && !answering
      ? activeReferenceQuery(displayedText, caret)
      : null;
  // Read when the picker opens and as the query narrows; nothing subscribes while it is closed.
  const referenceSections =
    referenceQuery === null
      ? []
      : personalReferenceSections(hostClient.getSnapshot(), referenceQuery.query, threadId);
  const changeText = (next: string): void => {
    draftText.current = next;
    const write = ++draftWrite.current;
    void drafts.writeDraft(deploymentId, userId, threadId, next).then(
      () => {
        if (draftWrite.current === write) setDraftFailure(null);
      },
      () => {
        if (draftWrite.current === write) {
          setDraftFailure("This draft could not be saved on this phone.");
        }
      },
    );
  };
  /** Puts other words in the field outright; a keystroke still on its way cannot undo it. */
  const replaceText = (next: string): void => {
    changeText(next);
    const editor = input.current;
    editor?.restore({
      composing: false,
      generation: editor.readSnapshot().generation + 1,
      selection: { start: next.length, end: next.length },
      text: next,
    });
  };

  // Dictation shows its words in the field without making them the draft or an undo
  // step; when it ends the field returns to the draft, with the words if they were kept.
  const committedSelection = useRef<{ text: string; start: number; end: number } | null>(null);
  const dictationBase = useRef(selection.current);
  const previewing = useRef(false);
  useEffect(() => {
    const editor = input.current;
    if (preview) {
      previewing.current = true;
      selection.current = preview.selection;
      editor?.preview({ ...editor.readSnapshot(), composing: false, ...preview });
      return;
    }
    if (!previewing.current) return;
    previewing.current = false;
    const committed = committedSelection.current;
    committedSelection.current = null;
    const next = draftText.current;
    const at = committed?.text === next ? committed : dictationBase.current;
    if (editor === null) return;
    editor.restore({
      composing: false,
      generation: editor.readSnapshot().generation,
      selection: { start: Math.min(at.start, next.length), end: Math.min(at.end, next.length) },
      text: next,
    });
  }, [preview?.text]);
  useEffect(() => {
    if (readOnly || textHidden || answering) dictation.leave(owner);
  }, [readOnly, textHidden, answering, dictation, owner]);
  const phase = speechView.phase;
  const notice = speechView.notice?.message ?? null;
  const previousPhase = useRef(phase);
  useEffect(() => {
    const previous = previousPhase.current;
    previousPhase.current = phase;
    if (!visible.current) return;
    if (phase === "idle" && previous !== "idle" && previous !== "downloading" && notice === null)
      AccessibilityInfo.announceForAccessibility(dictationLabels.stopped);
    if (phase === "listening") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      AccessibilityInfo.announceForAccessibility(dictationLabels.listening);
    } else if (phase === "starting")
      AccessibilityInfo.announceForAccessibility(dictationLabels.starting);
    else if (phase === "finishing")
      AccessibilityInfo.announceForAccessibility(dictationLabels.finishing);
    else if (phase === "downloading")
      AccessibilityInfo.announceForAccessibility("Downloading language for dictation");
  }, [phase]);
  useEffect(() => {
    if (notice && visible.current) AccessibilityInfo.announceForAccessibility(notice);
  }, [notice]);
  // While voice holds the microphone, dictation steps aside on every composer.
  const voiceOn = useVoiceOn();
  const startDictation = (): void => {
    if (voiceOn) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dictation.start({
      owner,
      read: () => {
        dictationBase.current = selection.current;
        return {
          text: drafts.readDraft(deploymentId, userId, threadId)?.text ?? "",
          selection: selection.current,
        };
      },
      commit: (next, caret) => {
        selection.current = caret;
        if (mounted.current && currentOwner.current === owner)
          committedSelection.current = { text: next, ...caret };
        void drafts.writeDraft(deploymentId, userId, threadId, next).catch(() => {
          if (mounted.current && currentOwner.current === owner)
            setDraftFailure("This draft could not be saved on this phone.");
        });
        if (mounted.current) {
          draftText.current = next;
        }
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
    });
  };
  const editText = (next: string): void => {
    changeText(next);
    dictation.release(owner);
  };

  // The update this message answers. It lives with the draft, so it survives
  // leaving the screen and relaunching the app exactly as the words do.
  const changeQuote = (next: ThreadDraftQuote | null): void => {
    void drafts.writeDraftQuote(deploymentId, userId, threadId, next).catch(() => {
      setDraftFailure("This quote could not be saved on this phone.");
    });
  };

  const changePage = (next: BrowserPageContentPart | null): void => {
    void drafts.writeDraftPage(deploymentId, userId, threadId, next).catch(() => {
      setDraftFailure("This page could not be saved on this phone.");
    });
  };
  /** Takes the shown page off this message, the page in front included. */
  const removePage = (): void => {
    if (draftPage !== null) changePage(null);
    setDeclinedPage(offeredKey);
  };

  const restore = props.restore ?? null;
  useEffect(() => {
    if (restore === null) return;
    const current = draftText.current;
    if (restore.text) replaceText(current.trim() ? `${restore.text}\n${current}` : restore.text);
    // A restore without a quote leaves the one already standing; only an
    // explicit null takes it away.
    if (restore.quote !== undefined) changeQuote(restore.quote);
    // Files already on the Host come back by reference; this phone has no copy.
    const parts = restore.attachments ?? [];
    if (parts.length > 0) staged.restore(parts.map((part) => ({ localUri: null, part })));
    input.current?.focus();
    // Only a new hand-back is applied; a re-render leaves the draft alone.
  }, [restore]);

  useEffect(() => {
    if (refused === null) return;
    setRefused(null);
    if (refused.text) {
      const current = draftText.current;
      replaceText(current.trim() ? `${refused.text}\n${current}` : refused.text);
    }
    // Each file returns with this phone's copy when it has one, and by
    // reference to the Host's when it does not.
    staged.restore(
      (refused.attachments ?? []).map((part, index) => ({
        localUri: refused.localUris?.[index] ?? null,
        part,
      })),
    );
    // The page goes back with the words, as the message was written: the one
    // it carried, onto the draft unless Ask has put another there since, or
    // none if it had been taken off.
    if (refused.browserPage === undefined) setDeclinedPage(offeredKey);
    else if (drafts.readDraft(deploymentId, userId, threadId)?.page === undefined) {
      changePage(refused.browserPage);
    }
    if (refused.quotedMessageId !== undefined && quote === null) {
      // The excerpt is gone with the sent message; the reference is what
      // matters, and it is shown as the source it is.
      changeQuote({
        attribution: "Quoted update",
        excerpt: "",
        messageId: refused.quotedMessageId,
      });
    }
    // Only a new refusal is handed back; a re-render leaves the draft alone.
  }, [refused]);

  /**
   * The Thread's one claim, in this bar's name. A pending command is durable
   * before it is dispatched, so the claim it was sent under outlives the call
   * that made it and its retry continues that claim rather than asking for a
   * second one; anything else waiting on the Host — a settings change whose
   * sheet has been dismissed, a Request answer — holds the claim instead and
   * this returns null.
   */
  const claimMessage = useCallback(
    (): ThreadMutationClaim | null => props.mutationGate.acquire("message"),
    [props.mutationGate],
  );

  const returnHint = useHostSelector(
    hostClient,
    (snapshot) => snapshot.threads.find((thread) => thread.id === threadId)?.returnHint,
  );
  const compactionOffer = useCompactionOffer(
    returnHint,
    `${deploymentId}/${userId}/${threadId}`,
    useMobileClient().usageNotices,
  );
  const sendMessage = async (
    sourceText: string,
    choice?: import("@opensteer/core").CompactionSendChoice,
  ): Promise<void> => {
    if (!canSend || inFlight.current || (sourceText.trim() === "" && staged.items.length === 0))
      return;
    // Every file is on the Host, or Send is not offered: words never go on
    // without the files meant to travel with them.
    const carried = staged.items;
    const attachments = carried.flatMap((item) => {
      const part = draftAttachmentPart(item);
      return part === null ? [] : [part];
    });
    if (attachments.length !== carried.length) return;
    if (!(await authorizeAiSharing(aiSharing, hostClient))) return;
    if (!mounted.current || inFlight.current || outbox === null) return;
    const claim = claimMessage();
    if (claim === null) return;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    try {
      // Before the network, and awaited: the device has to know about this
      // message before the Host does.
      // Which private copy is which file travels with the command, one entry
      // per file and null for a file only the Host holds, so a relaunch can
      // still hand a refused message's files back, or delete the copies once
      // the Host has them.
      if (!outbox) return;
      await outbox.enqueue(
        {
          type: "thread.sendMessage",
          threadId,
          content: [
            ...(sourceText.trim() ? [{ type: "text" as const, text: sourceText.trim() }] : []),
            ...(includedPage ? [includedPage] : []),
            ...attachments,
          ],
          delivery: "queue",
          idempotencyKey: mutationIdempotencyKey("message"),
          ...(choice || compactionOffer.visible ? { compaction: choice ?? "compactFirst" } : {}),
          ...(quote ? { quotedMessageId: quote.messageId } : {}),
        },
        { localAttachmentUris: carried.map((item) => item.localUri) },
      );
      void notifications.registration.afterSuccessfulSend();
      const draftNow = drafts.readDraft(deploymentId, userId, threadId);
      if (draftNow?.text === sourceText)
        await drafts.writeDraft(deploymentId, userId, threadId, "");
      // Felt as it is written down, which is when the transcript draws it.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (choice === "keepFullHistory") compactionOffer.dismiss();
      // The claim took the draft's words; the field empties unless words were
      // typed while it was being written. Read the store, not the render's copy,
      // which the claim may already have emptied.
      const left = drafts.readDraft(deploymentId, userId, threadId)?.text ?? "";
      if (left === "" || left === sourceText) replaceText("");
      changeQuote(null);
      setDeclinedPage(null);
      staged.release(carried.map(attachmentKey));
    } catch (error) {
      const issue = clientIssue(error, { operation: "action", label: "save this message" });
      setFailure(issue === null ? null : issueLine(issue, `send:${Date.now()}`));
    } finally {
      inFlight.current = false;
      setSending(false);
      props.mutationGate.release(claim);
    }
  };

  const latestSend = useRef({ canSend, sendMessage });
  latestSend.current = { canSend, sendMessage };
  const finishingSend = useRef(false);
  const send = async (choice?: import("@opensteer/core").CompactionSendChoice): Promise<void> => {
    if (finishingSend.current) return;
    finishingSend.current = true;
    try {
      const generation = input.current?.readSnapshot().generation ?? null;
      const result = dictating ? await dictation.stop(owner) : { kind: "idle" as const };
      if (result.kind === "failed" || result.kind === "aborted" || !mounted.current) return;
      let words = result.kind === "committed" ? result.text : draftText.current;
      // The field's last keystroke, or an autocorrection the tap on Send accepted, can
      // still be on its way to React: read what the field holds now.
      if (result.kind !== "committed" && input.current !== null && generation !== null) {
        const flushed = await input.current.flushPendingInput(generation).catch(() => null);
        if (flushed === null || flushed.composing) return;
        words = flushed.text;
      }
      if (!mounted.current || !visible.current || !latestSend.current.canSend) return;
      await latestSend.current.sendMessage(words, choice);
    } finally {
      finishingSend.current = false;
    }
  };

  const stop = async (): Promise<void> => {
    if (stoppingRef.current || props.runStopping) return;
    const unsent = props.canRespond
      ? null
      : (notSentIssue(props.hostClient, "stopped") ?? notSent("stopped"));
    if (unsent !== null) {
      setFailure(issueLine(unsent, `stop:${Date.now()}`));
      return;
    }
    setFailure(null);
    stoppingRef.current = true;
    setStopping(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    try {
      await props.hostClient.stopRun(props.threadId);
    } catch (error) {
      const issue = clientIssue(error, { operation: "action", label: "stop this run" });
      setFailure(
        issue === null ? null : issueLine({ ...issue, done: "stopped" }, `stop:${Date.now()}`),
      );
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };

  // Not the connection: offline, an answer is tapped and said not to have gone out.
  const canStartRequestResponse = (): boolean =>
    !readOnly && props.disabledReason === null && !inFlight.current;

  const requestDisabledReason = readOnly
    ? "This thread is archived."
    : props.disabledReason !== null
      ? props.disabledReason
      : sending
        ? "Finish sending your message before responding."
        : null;

  const hold = useCallback(() => setPresenting(true), []);
  const settle = useCallback(() => setPresenting(false), []);

  const cannotAttach = disabled || textHidden || staged.items.length >= attachmentMessageMaxCount;
  const menuOptions: readonly NativeMenuOption[] = [
    {
      disabled: cannotAttach,
      icon: "paperclip",
      id: "attach-file",
      label: "Attach file…",
      onPress: () => void staged.pick("file"),
    },
    {
      disabled: cannotAttach,
      icon: "photo",
      id: "attach-photo",
      label: "Attach photo…",
      onPress: () => void staged.pick("photo"),
    },
    {
      icon: "gearshape",
      id: "model",
      label: props.variant === "conversation" ? "AI settings" : "Change model…",
      onPress: () => props.onChangeModel(),
    },
    ...props.conversationActions,
    ...(props.running
      ? [
          {
            destructive: true,
            icon: "stop.fill" as const,
            id: "stop",
            label: props.stopLabel ?? "Stop run",
            onPress: () => void stop(),
          } satisfies NativeMenuOption,
        ]
      : []),
  ];

  const pageInBar = view.readOnly ? null : includedPage;
  if (done === "closed")
    return (
      <View style={styles.dock}>
        <View style={styles.done}>
          <AppText role="secondary">This task is Done · </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reopen"
            accessibilityState={{ disabled: !props.canRespond }}
            style={styles.reopen}
            disabled={!props.canRespond}
            onPress={() =>
              void hostClient
                .setTaskDone(threadId, false)
                .catch((error: unknown) =>
                  Alert.alert("Task not reopened", presentActionFailure(error)),
                )
            }
          >
            <AppText role="secondary" style={type.secondaryMedium}>
              Reopen
            </AppText>
          </Pressable>
        </View>
      </View>
    );
  return (
    <View style={styles.dock}>
      {surface === null ? null : question !== null ? (
        <Animated.View entering={appear}>
          <QuestionRequestCard
            canRespond={props.canRespond}
            canStartResponse={canStartRequestResponse}
            composer={answering ? "answer" : "message"}
            deploymentId={deploymentId}
            disabledReason={requestDisabledReason}
            highlighted={question.request.id === props.highlightRequestId}
            hostClient={hostClient}
            key={question.request.id}
            mutationGate={props.mutationGate}
            {...(answering
              ? holdsDraft
                ? { onBackToMessage: () => setAnswerInstead(null) }
                : {}
              : { onAnswerHere: () => setAnswerInstead(question.request.id) })}
            surface={question}
          />
        </Animated.View>
      ) : (
        <Animated.View entering={appear}>
          <RequestCard
            canRespond={props.canRespond}
            deploymentId={deploymentId}
            highlighted={surface.request.id === props.highlightRequestId}
            onPresent={hold}
            onSettle={settle}
            canStartResponse={canStartRequestResponse}
            disabledReason={requestDisabledReason}
            hostClient={props.hostClient}
            key={surface.request.id}
            mutationGate={props.mutationGate}
            surface={surface}
          />
        </Animated.View>
      )}
      {failure === null ? null : (
        <View style={styles.failure}>
          <ActionLine line={failure} numberOfLines={2} onDismiss={() => setFailure(null)} />
        </View>
      )}
      {filesWait ? (
        <View style={styles.failure}>
          <AppText role="caption" tone="muted">
            {presentClientIssue({ code: "preparation-required" }).detail}
          </AppText>
        </View>
      ) : null}
      {draftFailure === null ? null : (
        <Animated.View entering={enter} exiting={exit} style={styles.failure}>
          <AppText role="secondary" tone="danger">
            {draftFailure}
          </AppText>
        </Animated.View>
      )}
      {quote === null || view.readOnly || answering ? null : (
        <View accessibilityLabel="Quoted update" style={styles.quote}>
          <View style={styles.quoteText}>
            <AppText numberOfLines={1} role="secondaryMedium">
              {quote.attribution}
            </AppText>
            {quote.excerpt === "" ? null : (
              <AppText numberOfLines={2} role="secondary" tone="muted">
                {quote.excerpt}
              </AppText>
            )}
          </View>
          <Pressable
            accessibilityLabel="Remove quote"
            accessibilityRole="button"
            hitSlop={space[8]}
            onPress={() => changeQuote(null)}
            style={styles.quoteRemove}
          >
            <AppText role="secondaryMedium" tone="muted">
              Remove
            </AppText>
          </Pressable>
        </View>
      )}
      {view.readOnly || answering ? null : (
        <AttachmentStrip
          disabled={disabled}
          items={staged.items}
          notice={staged.notice}
          onRemove={staged.remove}
          onRetry={staged.retry}
        />
      )}
      {done === "reopens" ? (
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="caption"
          style={styles.doneHint}
          tone="muted"
        >
          Done · Sending reopens it
        </AppText>
      ) : null}
      {compactionOffer.visible && !answering ? (
        <View style={{ padding: space[14] }}>
          <AppText role="caption" tone="muted">
            {compactionOfferText}
          </AppText>
          <Pressable
            accessibilityRole="button"
            disabled={!canSend}
            onPress={() => void send("compactFirst")}
            style={{ minHeight: touchTarget, justifyContent: "center" }}
          >
            <AppText role="caption">Summarize and send</AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!canSend}
            onPress={() => void send("keepFullHistory")}
            style={{ minHeight: touchTarget, justifyContent: "center" }}
          >
            <AppText role="caption">Send with full history</AppText>
          </Pressable>
        </View>
      ) : null}
      {referenceQuery === null ? null : (
        <ComposerReferencePicker
          onPick={(row) => insertReference(input.current, referenceQuery, caret, row.markdown)}
          sections={referenceSections}
        />
      )}
      <DictationStatus controller={dictation} snapshot={dictationState} owner={owner} />
      <VoiceDock />
      {answering ? (
        <AnswerBar
          canRespond={props.canRespond}
          canStartResponse={canStartRequestResponse}
          gate={props.mutationGate}
          hostClient={hostClient}
          key={question.request.id}
          onStop={props.running ? () => void stop() : null}
          stopBusy={stopping || props.runStopping}
          stopLabel={props.stopLabel ?? "Stop this run"}
          surface={question}
        />
      ) : (
        <ComposerBar
          shape={view.shape}
          // The page stands above the words once the bar opens. At rest the
          // capsule's one line belongs to the words, and the placeholder names it.
          {...(pageInBar === null || view.shape !== "rounded"
            ? {}
            : {
                caption: <IncludedPage onRemove={removePage} page={pageInBar} />,
              })}
          {...(view.readOnly
            ? {}
            : {
                leading: (
                  <View style={styles.leading}>
                    <NativeMenu
                      accessibilityHint="Change the model, and what else can be done here"
                      accessibilityLabel="Thread actions"
                      onPresent={hold}
                      onSettle={settle}
                      options={menuOptions}
                    >
                      <ComposerGlyph icon="plus" />
                    </NativeMenu>
                    {view.shape === "rounded" && view.showField && !textHidden ? (
                      <Pressable
                        accessibilityHint="Puts a link to a task, automation or computer in your message"
                        accessibilityLabel="Add a reference"
                        accessibilityRole="button"
                        disabled={disabled}
                        onPress={() => startReference(input.current)}
                      >
                        <ComposerGlyph icon="at" muted={disabled} />
                      </Pressable>
                    ) : null}
                  </View>
                ),
              })}
          field={
            view.readOnly ? (
              // An archived thread keeps its bar so the screen does not change
              // shape when it is opened, and keeps nothing else: there is no
              // draft to save and no setting left that would take effect.
              <View style={styles.archived}>
                <AppText numberOfLines={2} role="secondary" tone="muted">
                  {props.disabledReason ?? "This thread is archived."}
                </AppText>
              </View>
            ) : view.showField ? (
              // The lane, not the field, is what is centred against the controls:
              // a single line of any Dynamic Type size sits level with them, and
              // a tap in the lane's margin still reaches the field.
              <Pressable
                accessible={false}
                onPress={() => input.current?.focus()}
                // A touch that reaches the field is proof no menu is over it any
                // more: iOS gives no dismissal event for a native menu, and this
                // is the moment the bar can stop holding its shape for one.
                onTouchStart={settle}
                style={styles.lane}
              >
                <ComposerEditor
                  accessibilityLabel="Message"
                  maxHeight={fieldMaxHeight}
                  maxImageBytes={attachmentMaxBytes}
                  onBlur={() => setFocused(false)}
                  onChangeText={editText}
                  onFocus={() => {
                    setFocused(true);
                    settle();
                  }}
                  onPasteImages={(pasted) => void staged.paste(pasted)}
                  onSelectionChange={(next) => {
                    selection.current = next;
                    setCaret(next.start);
                  }}
                  paddingVertical={fieldPadding}
                  placeholder={pageInBar === null ? props.placeholder : "Ask about this page…"}
                  ref={input}
                  scope="personal"
                  value={text}
                />
              </Pressable>
            ) : (
              // The open Request is answered by choosing, so the bar holds only
              // its controls — and still holds the line they sit on.
              <View style={styles.spacer} />
            )
          }
          {...(view.action === null
            ? {}
            : {
                action: (
                  <View style={{ flexDirection: "row" }}>
                    {!dictating && !voiceOn ? (
                      <DictationMic
                        controller={dictation}
                        snapshot={dictationState}
                        owner={owner}
                        disabled={readOnly || textHidden}
                        onStart={startDictation}
                      />
                    ) : null}
                    {!dictating ? (
                      <View>
                        {view.action === "voice" ? (
                          <VoiceMic disabled={readOnly || textHidden} face="disc" />
                        ) : view.action === "stop" ? (
                          <ComposerAction
                            busy={stopping || props.runStopping}
                            disabled={stopping || props.runStopping}
                            kind="stop"
                            label={props.stopLabel ?? "Stop this run"}
                            onPress={() => void stop()}
                          />
                        ) : (
                          <ComposerAction
                            busy={sending}
                            disabled={!canSend}
                            kind="send"
                            label={
                              sending
                                ? "Sending"
                                : compactionOffer.visible
                                  ? "Summarize and send"
                                  : "Send message"
                            }
                            onPress={() => void send()}
                          />
                        )}
                      </View>
                    ) : null}
                  </View>
                ),
              })}
          {...(dictating
            ? {
                accessory: (
                  <DictationBar
                    canSend={canSend}
                    controller={dictation}
                    onSend={() => void send()}
                    owner={owner}
                    snapshot={dictationState}
                  />
                ),
              }
            : view.showPills
              ? {
                  accessory: (
                    <View>
                      <ComposerPills
                        accessMode={props.accessMode}
                        accessModes={props.accessModes}
                        disabledReason={props.settingsDisabledReason}
                        blockedReason={props.executionBlockedReason}
                        driverKind={props.driverKind}
                        engineName={props.engineName}
                        modelLabel={props.modelLabel}
                        model={props.model}
                        modelOptions={props.modelOptions}
                        onOpenModel={() => props.onChangeModel()}
                        onPresent={hold}
                      />
                    </View>
                  ),
                }
              : {})}
        />
      )}
      {view.readOnly ? null : (
        <UsageNotice notice={props.usageNotice ?? null} onOpen={props.onChangeModel} />
      )}
    </View>
  );
}

/**
 * The message this phone still owes the Host: shown with its own words, so a
 * send that has not landed is visible rather than lost between the composer and
 * the transcript.
 */
function IncludedPage(props: {
  readonly onRemove: () => void;
  readonly page: BrowserPageContentPart;
}): ReactNode {
  return (
    <View style={styles.page}>
      <Symbol name="globe" size={12} tint={color.textSoft} />
      <AppText
        accessibilityLabel={`${props.page.title || "This page"}. This page is included with your message`}
        numberOfLines={1}
        role="caption"
        style={styles.pageTitle}
      >
        {props.page.title || "This page"}
      </AppText>
      <Pressable
        accessibilityLabel="Remove page"
        accessibilityRole="button"
        hitSlop={space[10]}
        onPress={props.onRemove}
        style={styles.pageRemove}
      >
        <Symbol name="xmark" size={10} tint={color.muted} weight="semibold" />
      </Pressable>
    </View>
  );
}

/**
 * The field's padding, the same above and below. One 24-point body line plus
 * this on each side fills the 36-point lane, so a wrapped last line stays level
 * with the controls the way the first line is.
 */
const fieldPadding = space[6];

const styles = StyleSheet.create({
  // The update the next message answers. The excerpt is shown so the reader
  // knows what they are asking about; only its id is ever sent.
  quote: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderLeftColor: color.ember,
    borderLeftWidth: 2,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    paddingHorizontal: space[12],
    paddingVertical: space[8],
  },
  quoteRemove: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  quoteText: { flex: 1, gap: space[2] },
  done: { alignItems: "center", flexDirection: "row", paddingHorizontal: space[16] },
  doneHint: { paddingHorizontal: space[16] },
  reopen: { minHeight: touchTarget, justifyContent: "center", paddingHorizontal: space[8] },
  archived: {
    flex: 1,
    justifyContent: "center",
    minHeight: composerLaneHeight,
    paddingHorizontal: space[6],
  },
  disabled: { opacity: 0.45 },
  leading: { flexDirection: "row" },
  dock: { gap: space[8] },
  failure: { paddingHorizontal: space[12] },
  lane: { flex: 1, justifyContent: "center", minHeight: composerLaneHeight },
  page: {
    ...material.control,
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    maxWidth: 240,
    minHeight: 26,
    paddingLeft: space[8] - 1,
  },
  pageRemove: { alignItems: "center", height: 26, justifyContent: "center", width: 26 },
  pageTitle: { flexShrink: 1 },
  spacer: { flex: 1, minHeight: composerLaneHeight },
});
