import { useHostSelector } from "@opensteer/client/react";
import { useFocusEffect } from "@react-navigation/native";
import { VoiceDock, VoiceMic, useVoice, useVoiceAvailable } from "../voice/controls.js";
import { useId } from "react";
import { useDictation } from "../dictation/context.js";
import { DictationBar, DictationMic, DictationStatus } from "../dictation/controls.js";
import { dictationLabels, dictationView } from "@opensteer/client/dictation";
import { useMobileNotifications } from "../ui/notifications-context.js";
import {
  deriveSurface,
  isHostRefusal,
  mutationIdempotencyKey,
  type HostClient,
  type UsageLimitNotice,
} from "@opensteer/client/host";
import {
  attachmentMessageMaxCount,
  buildMobileThreadDeepLink,
  DeploymentIdSchema,
  ThreadIdSchema,
  type ArtifactContentPart,
  type AuthenticatedUser,
  type BrowserPageContentPart,
  type Request,
  type ModelSelection,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { HarnessModelDescriptor, MachineSummary } from "@opensteer/protocol";
import * as Clipboard from "expo-clipboard";
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
  TextInput,
  type TextInputInstance,
  useWindowDimensions,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { operationDetail } from "../client/mobile-client.js";
import type {
  PendingCommand,
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
import { ComposerBar, ComposerGlyph, composerLaneHeight } from "./composer-bar.js";
import { NativeMenu, type NativeMenuOption } from "./composer-menu.js";
import { composerView } from "./composer-model.js";
import { ComposerPills } from "./composer-pills.js";
import { AttachmentStrip } from "./attachment-views.js";
import {
  attachmentKey,
  draftAttachmentPart,
  forgetDraftFiles,
  useDraftAttachments,
} from "./draft-attachments.js";
import { RequestCard } from "./request-card.js";
import { beginPendingDelivery, sendPendingMessage } from "./send-pending-message.js";
import type { ThreadMutationClaim, ThreadMutationGate } from "./thread-mutation-gate.js";
import { UsageNotice } from "./usage-notice.js";

/**
 * The one surface at the bottom of a Thread: the composer, and whatever
 * Opensteer is currently waiting on, docked into it.
 *
 * Two pieces of text live here and they are deliberately different things. The
 * draft is what is being typed and is the person's to change. The pending
 * command is the message that was handed to the Host — its words and its
 * idempotency key, fixed together — and nothing changes it, because a retry
 * under a key the Host has already seen must be the same message or it is a
 * second one. It is written to the device and the write is awaited before the
 * command is dispatched; a write that fails stops the send and says so, because
 * a message sent under a key no relaunch can find is a message that can be sent
 * twice. Typing while one is in flight edits the draft and leaves the command
 * alone.
 */
export function Composer(props: {
  readonly variant?: "conversation" | "work";
  /** What this Thread may do without asking, named in AI settings. */
  readonly accessMode: ThreadAccessMode;
  /** The modes this Thread's engine can enforce, or null while it has not said. */
  readonly accessModes: readonly ThreadAccessMode[] | null;
  /** False while the Host is unreachable: a decision is never queued. */
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
  /** The Deployment's computers, so a Request about one can name it. */
  readonly machines: readonly MachineSummary[];
  /** What the next message will run on, in the words the settings sheet uses. */
  readonly modelLabel: string;
  readonly model: HarnessModelDescriptor | null;
  readonly modelOptions: ModelSelection["options"];
  readonly mutationGate: ThreadMutationGate;
  /**
   * The page the person is looking at, included with the next message unless
   * they remove it. Removing it holds for this message and this page only.
   */
  readonly page?: BrowserPageContentPart | null;
  readonly onChangeModel: (conversation?: boolean) => void;
  /** Opens Find in conversation for this Thread. */
  readonly onFind: () => void;
  readonly placeholder: string;
  readonly requests: readonly Request[];
  /**
   * Folded under a page, the pending Request is one line above the bar, and
   * its card waits for the conversation to be opened.
   */
  readonly requestFolded?: boolean;
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
  /** Each subagent this Thread's Runs started, by node id, so a Request one asked can say so. */
  readonly subagentTitles: ReadonlyMap<string, string>;
  readonly threadId: string;
  /** The line under the bar while this Thread's account is out of plan capacity. */
  readonly usageNotice?: UsageLimitNotice | null;
  readonly user: AuthenticatedUser;
  /** Chat's composer, which offers the voice button beside the microphone. */
  readonly voice?: boolean;
  /** Where this Thread's attached files are uploaded; null until the Thread is known. */
  readonly workspaceId: string | null;
}): ReactNode {
  const surface = useMemo(
    () => deriveSurface(props.requests, props.user),
    [props.requests, props.user],
  );
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
  const speechView = dictationView(dictationState, owner);
  const preview = speechView.preview;
  const dictating = ["starting", "listening", "finishing"].includes(speechView.phase);
  const displayedText = preview?.text ?? text;
  const visible = useRef(false);
  useFocusEffect(
    useCallback(() => {
      visible.current = true;
      return () => {
        visible.current = false;
        dictation.leave(owner);
      };
    }, [dictation, owner]),
  );
  const quote = draft?.quote ?? null;
  const pending = drafts.readPending(deploymentId, userId, threadId);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [draftFailure, setDraftFailure] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInputInstance>(null);
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
  const attempted = useRef<string | null>(null);
  /** A message the Host refused, on its way back into the draft. */
  const [refused, setRefused] = useState<PendingCommand | null>(null);
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
    workspaceId: props.workspaceId,
  });
  const attachmentsReady = staged.items.every((item) => draftAttachmentPart(item) !== null);

  // What the person decided about the page in front of them, for as long as
  // that same page stays in front of them: taken off this message, or the page
  // a refused message carried, given back. Another page, and the next message,
  // bring the offered page back.
  const offeredPage = props.page ?? null;
  const offeredKey = offeredPage === null ? "" : pageIdentity(offeredPage);
  const [pageChoice, setPageChoice] = useState<{
    readonly key: string;
    readonly page: BrowserPageContentPart | null;
  } | null>(null);
  const includedPage = pageChoice?.key === offeredKey ? pageChoice.page : offeredPage;

  const done = useHostSelector(
    hostClient,
    (snapshot) =>
      snapshot.sharedTaskDoneAvailable === true &&
      snapshot.threads.find((thread) => thread.id === threadId)?.doneAt != null,
  );
  const readOnly = done || (props.readOnly ?? false);
  const disabled = props.disabledReason !== null || !props.canRespond || readOnly;
  const textHidden = surface !== null && surface.textRole === "hidden";
  // Which control the bar shows, and whether its settings row is open, is
  // arithmetic over the state above — including the rule that keeps one message
  // in flight at a time, because a second claim would be a second key for a
  // Thread that has not answered the first.
  const voiceReady = useVoiceAvailable() && props.voice === true;
  const view = composerView({
    attachments: staged.items.length,
    attachmentsReady,
    canRespond: props.canRespond,
    disabledReason: props.disabledReason,
    focused,
    pendingCommand: pending !== null,
    presenting,
    readOnly,
    running: props.running,
    sending,
    text: displayedText,
    textHidden,
    voice: voiceReady,
  });
  const canSend =
    view.canSend || (dictating && !disabled && !sending && pending === null && attachmentsReady);
  const requestBlocked = disabled || sending || pending !== null;
  /**
   * The link a person shares to bring another device back here. It is built
   * from ids this phone already holds, and it is offered only when both parse:
   * a link that names nothing openable is worse than no menu entry.
   */
  const threadLink = useMemo(() => {
    const deployment = DeploymentIdSchema.safeParse(deploymentId);
    const thread = ThreadIdSchema.safeParse(threadId);
    if (!deployment.success || !thread.success) return null;
    return buildMobileThreadDeepLink({
      deploymentId: deployment.data,
      requestId: null,
      threadId: thread.data,
    });
  }, [deploymentId, threadId]);

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

  const committedSelection = useRef<{ text: string; start: number; end: number } | null>(null);
  useEffect(() => {
    const caret = committedSelection.current;
    if (caret && displayedText === caret.text) {
      input.current?.setSelection(caret.start, caret.end);
      committedSelection.current = null;
    }
  }, [displayedText, preview]);
  useEffect(() => {
    if (preview) {
      selection.current = preview.selection;
      input.current?.setSelection(preview.selection.start, preview.selection.end);
    }
  }, [preview?.text]);
  useEffect(() => {
    if (readOnly || textHidden) dictation.leave(owner);
  }, [readOnly, textHidden, dictation, owner]);
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
  const voiceOn = useVoice().snapshot.phase !== "idle";
  const startDictation = (): void => {
    if (voiceOn) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dictation.start({
      owner,
      read: () => ({
        text: drafts.readDraft(deploymentId, userId, threadId)?.text ?? "",
        selection: selection.current,
      }),
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

  const restore = props.restore ?? null;
  useEffect(() => {
    if (restore === null) return;
    const current = draftText.current;
    if (restore.text) changeText(current.trim() ? `${restore.text}\n${current}` : restore.text);
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
      changeText(current.trim() ? `${refused.text}\n${current}` : refused.text);
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
    // it carried, or none if it had been taken off.
    setPageChoice({ key: offeredKey, page: refused.browserPage ?? null });
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
    (): ThreadMutationClaim | null =>
      props.mutationGate.resume("message") ?? props.mutationGate.acquire("message"),
    [props.mutationGate],
  );

  const deliver = useCallback(
    async (command: PendingCommand): Promise<void> => {
      const endDelivery = beginPendingDelivery(drafts, deploymentId, userId, command);
      if (endDelivery === null) return;
      try {
        await sendPendingMessage(hostClient, command, notifications.registration);
        // Acknowledged, and only now: until this line the command is still the
        // one this phone owes the Host.
        const cleared = await drafts.clearPending(
          deploymentId,
          userId,
          threadId,
          command.idempotencyKey,
        );
        // The Host holds the message and its files, so this phone's copies of
        // them have done their job.
        if (cleared) {
          forgetDraftFiles({ deploymentId, threadId, userId }, command.localUris ?? []);
        }
        // Felt, because the message leaves the composer before the transcript
        // shows it and the hand has usually moved on by then.
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        if (isHostRefusal(error) && mounted.current) {
          // The Host answered no, so the message is no longer owed: its words
          // and files go back to the draft to be changed, and the next send is
          // a new message under a new key. The copies stay with the draft.
          try {
            if (await drafts.clearPending(deploymentId, userId, threadId, command.idempotencyKey)) {
              setRefused(command);
            }
          } catch {
            // Still held on this phone; Try again repeats the same refusal.
          }
        }
        setFailure(operationDetail(error, "That message did not reach your deployment."));
      } finally {
        endDelivery();
      }
    },
    [deploymentId, drafts, hostClient, notifications, threadId, userId],
  );

  const deliverExclusively = useCallback(
    async (command: PendingCommand): Promise<void> => {
      if (inFlight.current) return;
      const claim = claimMessage();
      if (claim === null) return;
      inFlight.current = true;
      setSending(true);
      setFailure(null);
      try {
        await deliver(command);
      } finally {
        inFlight.current = false;
        setSending(false);
        if (drafts.readPending(deploymentId, userId, threadId) === null) {
          props.mutationGate.release(claim);
        }
      }
    },
    [claimMessage, deliver, deploymentId, drafts, props.mutationGate, threadId, userId],
  );

  useEffect(() => {
    // A command the device came back holding, or one left over from a lost
    // answer, is retried when there is a Host to retry it to — with the key and
    // the words it was claimed under, never re-keyed.
    if (!props.canRespond || readOnly) {
      attempted.current = null;
      return;
    }
    if (pending === null || attempted.current === pending.idempotencyKey) return;
    attempted.current = pending.idempotencyKey;
    void deliverExclusively(pending);
  }, [deliverExclusively, pending, props.canRespond, readOnly]);

  const sendMessage = async (sourceText: string): Promise<void> => {
    if (
      !canSend ||
      inFlight.current ||
      drafts.readPending(deploymentId, userId, threadId) !== null ||
      (sourceText.trim() === "" && staged.items.length === 0)
    )
      return;
    // Every file is on the Host, or Send is not offered: words never go on
    // without the files meant to travel with them.
    const carried = staged.items;
    const attachments = carried.flatMap((item) => {
      const part = draftAttachmentPart(item);
      return part === null ? [] : [part];
    });
    if (attachments.length !== carried.length) return;
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
      await drafts.claimPending(deploymentId, userId, threadId, {
        ...(attachments.length > 0
          ? { attachments, localUris: carried.map((item) => item.localUri) }
          : {}),
        ...(includedPage === null ? {} : { browserPage: includedPage }),
        idempotencyKey: mutationIdempotencyKey("message"),
        ...(quote === null ? {} : { quotedMessageId: quote.messageId }),
        text: sourceText.trim(),
        threadId,
      });
      // Do not erase words typed while the durable claim was being written.
      if (draftText.current === sourceText) changeText("");
      changeQuote(null);
      setPageChoice(null);
      const claimed = drafts.readPending(deploymentId, userId, threadId);
      if (claimed === null) return;
      // The message holds the files now; files picked meanwhile stay on the strip.
      staged.release(carried.map(attachmentKey));
      attempted.current = claimed.idempotencyKey;
      await deliver(claimed);
    } catch (error) {
      setFailure(
        drafts.readPending(deploymentId, userId, threadId) === null
          ? "Couldn't save your message on this phone, so it wasn't sent. Try again."
          : operationDetail(error, "That message did not reach your deployment."),
      );
    } finally {
      inFlight.current = false;
      setSending(false);
      if (drafts.readPending(deploymentId, userId, threadId) === null) {
        props.mutationGate.release(claim);
      }
    }
  };

  const latestSend = useRef({ canSend, sendMessage });
  latestSend.current = { canSend, sendMessage };
  const finishingSend = useRef(false);
  const send = async (): Promise<void> => {
    if (finishingSend.current) return;
    finishingSend.current = true;
    try {
      const result = dictating ? await dictation.stop(owner) : { kind: "idle" as const };
      if (
        result.kind === "failed" ||
        result.kind === "aborted" ||
        !mounted.current ||
        !visible.current ||
        !latestSend.current.canSend
      )
        return;
      await latestSend.current.sendMessage(
        result.kind === "committed" ? result.text : draftText.current,
      );
    } finally {
      finishingSend.current = false;
    }
  };

  const retry = (): void => {
    if (!props.canRespond || readOnly || pending === null) return;
    attempted.current = pending.idempotencyKey;
    void deliverExclusively(pending);
  };

  const stop = async (): Promise<void> => {
    if (stoppingRef.current || props.runStopping || !props.canRespond) return;
    stoppingRef.current = true;
    setStopping(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    try {
      await props.hostClient.stopRun(props.threadId);
    } catch (error) {
      setFailure(operationDetail(error, "Opensteer could not be asked to stop."));
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };

  const hold = useCallback(() => setPresenting(true), []);
  const settle = useCallback(() => setPresenting(false), []);

  const cannotAttach =
    disabled ||
    textHidden ||
    props.workspaceId === null ||
    staged.items.length >= attachmentMessageMaxCount;
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
    {
      icon: "magnifyingglass",
      id: "find",
      label: "Find in conversation…",
      onPress: props.onFind,
    },
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
    ...(threadLink === null
      ? []
      : [
          {
            icon: "link" as const,
            id: "link",
            label: "Copy thread link",
            onPress: () => copyThreadLink(threadLink),
          },
        ]),
  ];

  if (done)
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
                  Alert.alert("Task not reopened", operationDetail(error, "Try again.")),
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
      {surface === null || props.requestFolded === true ? null : (
        <Animated.View entering={appear}>
          <RequestCard
            canRespond={props.canRespond && !requestBlocked}
            highlighted={surface.request.id === props.highlightRequestId}
            onPresent={hold}
            onSettle={settle}
            canStartResponse={() =>
              props.canRespond &&
              !readOnly &&
              props.disabledReason === null &&
              !inFlight.current &&
              drafts.readPending(deploymentId, userId, threadId) === null
            }
            disabledReason={
              readOnly
                ? "This thread is archived."
                : props.disabledReason !== null
                  ? props.disabledReason
                  : requestBlocked
                    ? "Finish sending your message before responding."
                    : null
            }
            hostClient={props.hostClient}
            key={surface.request.id}
            machines={props.machines}
            mutationGate={props.mutationGate}
            subagentTitle={
              surface.request.originatingNodeId === undefined
                ? null
                : (props.subagentTitles.get(surface.request.originatingNodeId) ?? null)
            }
            surface={surface}
          />
        </Animated.View>
      )}
      {pending === null ? null : (
        <Animated.View entering={enter} exiting={exit}>
          <PendingMessage
            attachments={pending.attachments ?? []}
            canRetry={props.canRespond && !readOnly}
            onRetry={retry}
            pageTitle={pending.browserPage?.title ?? null}
            sending={sending}
            text={pending.text}
          />
        </Animated.View>
      )}
      {failure === null ? null : (
        <Animated.View entering={enter} exiting={exit} style={styles.failure}>
          <AppText role="secondary" tone="danger">
            {failure}
          </AppText>
        </Animated.View>
      )}
      {draftFailure === null ? null : (
        <Animated.View entering={enter} exiting={exit} style={styles.failure}>
          <AppText role="secondary" tone="danger">
            {draftFailure}
          </AppText>
        </Animated.View>
      )}
      {quote === null || view.readOnly ? null : (
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
      {view.readOnly ? null : (
        <AttachmentStrip
          disabled={disabled}
          items={staged.items}
          notice={staged.notice}
          onRemove={staged.remove}
          onRetry={staged.retry}
        />
      )}
      <DictationStatus controller={dictation} snapshot={dictationState} owner={owner} />
      <VoiceDock />
      <ComposerBar
        // Two lines from the start: the page above the field is part of the box.
        shape={includedPage === null || view.readOnly ? view.shape : "rounded"}
        {...(includedPage === null || view.readOnly
          ? {}
          : {
              caption: (
                <IncludedPage
                  onRemove={() => setPageChoice({ key: offeredKey, page: null })}
                  page={includedPage}
                />
              ),
            })}
        {...(view.readOnly
          ? {}
          : {
              leading: (
                <View style={{ flexDirection: "row" }}>
                  <NativeMenu
                    accessibilityHint="Change the model, and what else can be done here"
                    accessibilityLabel="Thread actions"
                    onPresent={hold}
                    onSettle={settle}
                    options={menuOptions}
                  >
                    <ComposerGlyph icon="plus" />
                  </NativeMenu>
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
              style={styles.lane}
            >
              <TextInput
                accessibilityLabel="Message"
                cursorColor={color.ember}
                maxFontSizeMultiplier={controlFontScaleLimit}
                multiline
                onBlur={() => setFocused(false)}
                onChangeText={editText}
                onSelectionChange={(event) => {
                  selection.current = event.nativeEvent.selection;
                }}
                onFocus={() => {
                  setFocused(true);
                  settle();
                }}
                // A touch that reaches the field is proof no menu is over it any
                // more: iOS gives no dismissal event for a native menu, and this
                // is the moment the bar can stop holding its shape for one.
                onTouchStart={settle}
                placeholder={includedPage === null ? props.placeholder : "Ask about this page…"}
                placeholderTextColor={color.muted}
                ref={input}
                selectionColor={color.ember}
                style={[styles.input, { maxHeight: fieldMaxHeight }]}
                value={displayedText}
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
                          disabled={stopping || props.runStopping || !props.canRespond}
                          kind="stop"
                          label={props.stopLabel ?? "Stop this run"}
                          onPress={() => void stop()}
                        />
                      ) : (
                        <ComposerAction
                          busy={sending}
                          disabled={!canSend}
                          kind="send"
                          label={sending ? "Sending" : "Send message"}
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
function PendingMessage(props: {
  readonly attachments: readonly { readonly artifactId: string; readonly name: string }[];
  readonly canRetry: boolean;
  readonly onRetry: () => void;
  /** The page the message includes, by the title it had when it was sent. */
  readonly pageTitle: string | null;
  readonly sending: boolean;
  readonly text: string;
}): ReactNode {
  return (
    <View style={styles.pending}>
      {props.pageTitle === null ? null : (
        <AppText numberOfLines={1} role="caption" tone="muted">
          {props.pageTitle || "Page"}
        </AppText>
      )}
      {props.text ? (
        <AppText numberOfLines={3} role="secondary" tone="soft">
          {props.text}
        </AppText>
      ) : null}
      {props.attachments.map((part) => (
        <AppText key={part.artifactId} numberOfLines={1} role="caption" tone="muted">
          {part.name}
        </AppText>
      ))}
      <View style={styles.pendingFoot}>
        <AppText role="caption" tone="muted">
          {props.sending ? "Sending…" : "Not sent yet."}
        </AppText>
        {props.sending ? null : (
          <Pressable
            accessibilityLabel="Send this message again"
            accessibilityRole="button"
            hitSlop={space[8]}
            accessibilityState={{ disabled: !props.canRetry }}
            disabled={!props.canRetry}
            onPress={props.onRetry}
            style={[styles.pendingRetry, !props.canRetry && styles.disabled]}
          >
            <AppText role="secondaryMedium" tone="ember">
              Try again
            </AppText>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** One page, whatever its title becomes: its browser, its tab and its address. */
function pageIdentity(page: BrowserPageContentPart): string {
  return `${page.sessionId}\u0000${page.tabId}\u0000${page.url}`;
}

/**
 * The page the next message includes, top-left in the box: its title, and ×
 * to leave it out of this message.
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
 * The field's padding, the same above and below. One line in the system font's
 * own height — about 20 points at the default size — plus this on each side
 * fills the 36-point lane, so a wrapped last line stays level with the controls
 * the way the first line is.
 */
const fieldPadding = space[8];

function copyThreadLink(link: string): void {
  void Clipboard.setStringAsync(link).then(
    () => Haptics.selectionAsync(),
    () => Alert.alert("Link not copied", "This thread's link could not be put on the clipboard."),
  );
}

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
  reopen: { minHeight: touchTarget, justifyContent: "center", paddingHorizontal: space[8] },
  archived: {
    flex: 1,
    justifyContent: "center",
    minHeight: composerLaneHeight,
    paddingHorizontal: space[6],
  },
  disabled: { opacity: 0.45 },
  dock: { gap: space[8] },
  failure: { paddingHorizontal: space[12] },
  pending: {
    ...material.plate,
    borderRadius: radius.sm,
    gap: space[4],
    paddingHorizontal: space[10] - (1 - StyleSheet.hairlineWidth),
    paddingVertical: space[8] - (1 - StyleSheet.hairlineWidth),
  },
  pendingFoot: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[12] },
  pendingRetry: { justifyContent: "center", minHeight: touchTarget },
  // No `lineHeight`. React Native gives a multiline iOS field that value as a
  // paragraph's minimum and maximum line height and, unlike `Text`, never adds
  // the baseline offset that centres the glyphs in it — so UIKit puts all the
  // extra height above them and the words and the placeholder sit low in their
  // own line. The font's own line height has nothing to redistribute. The field
  // grows line by line from there, then scrolls inside itself rather than
  // pushing the transcript off the screen.
  input: {
    color: color.text,
    fontSize: type.body.fontSize,
    fontWeight: type.body.fontWeight,
    includeFontPadding: false,
    paddingHorizontal: 0,
    paddingVertical: fieldPadding,
    textAlignVertical: "top",
  },
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
