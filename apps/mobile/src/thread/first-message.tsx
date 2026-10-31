import { VoiceDock, VoiceMic, useVoiceAvailable } from "../voice/controls.js";
import {
  accountGettingReady,
  accessModeConflict,
  placementForSelection,
  composerExecutionSelection,
  defaultThreadPlacement,
  lastExecutionSelection,
  preparingPlacement,
  threadPlacementOptions,
  usageLimitNotice,
  type ExecutionSelection,
  type HostSnapshot,
  type ThreadPlacementOption,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import type { ThreadAccessMode } from "@opensteer/core";
import { useHeaderHeight } from "@react-navigation/elements";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  useWindowDimensions,
  View,
} from "react-native";
import type {
  PendingCommand,
  PendingThreadStart,
  ThreadDraftQuote,
  ThreadDraftStore,
} from "../client/thread-drafts.js";
import {
  copyFirstMessageDraftFileToThread,
  type AttachmentDraftScope,
  type FirstMessageAttachmentDraftScope,
} from "../platform/attachment-draft-files.js";
import { color, controlFontScaleLimit, radius, space, touchTarget, type } from "../theme.js";
import { ComposerAction } from "../ui/composer-action.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { useContentInsets } from "../ui/pane.js";
import { useGutter, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { ComposerPills } from "./composer-pills.js";
import { UsageNotice } from "./usage-notice.js";
import { AttachmentStrip } from "./attachment-views.js";
import { ComposerBar, ComposerGlyph, composerLaneHeight } from "./composer-bar.js";
import { NativeMenu, type NativeMenuOption } from "./composer-menu.js";
import {
  attachmentKey,
  draftAttachmentPart,
  forgetDraftFiles,
  type DraftAttachments,
} from "./draft-attachments.js";
import {
  beginFirstMessagePickerAttempt,
  cancelFirstMessagePickerAttempt,
} from "./first-message-picker-attempt.js";

/**
 * A first message: words written before the Thread they start exists.
 *
 * Chat's first message creates the one Home; a new task's creates that task.
 * Both are real drafts and a real choice of AI, kept on this phone under a
 * reserved key until the Host has made the Thread, and then handed to that
 * Thread's own composer, which sends them exactly as written under the key
 * they were claimed with. Nothing about either is invented: no conversation
 * exists until the first message does.
 */

/** Chat's one Home, or a new task. */
export type FirstMessageTarget = "home" | "task";

/** The draft key a new task's first message is written under, one per Workspace. */
export function newTaskDraftKey(workspaceId: string): string {
  return `new-task:${workspaceId}`;
}

/** Which AI a first message would start its Thread on. */
export interface FirstMessageExecution {
  readonly accessMode: ThreadAccessMode;
  readonly accessReason: string | null;
  readonly placements: readonly ThreadPlacementOption[];
  /** The placements that can run right now. */
  readonly runnable: readonly ThreadPlacementOption[];
  /** What sending would start on, or null while that is a question. */
  readonly selection: ExecutionSelection | null;
  /**
   * A remembered choice that no longer runs. It stays named rather than being
   * replaced: the person chose that account, and silence reads as losing it.
   */
  readonly blocked: ExecutionSelection | null;
  /** Where that choice runs, while its account is still here. */
  readonly blockedPlacement: ThreadPlacementOption | null;
}

/**
 * What a first message starts on when nothing has been chosen.
 *
 * A task takes the deployment's default. Chat takes an account only when
 * exactly one can run: which one runs — and pays for — the conversation a
 * person lives in is theirs to say, so several are a question.
 */
export function startingPlacement(
  target: FirstMessageTarget,
  snapshot: Pick<HostSnapshot, "environments" | "harnesses">,
  runnable: readonly ThreadPlacementOption[],
): ThreadPlacementOption | null {
  if (target === "task") {
    return defaultThreadPlacement(snapshot.environments, snapshot.harnesses) ?? null;
  }
  return runnable.length === 1 ? (runnable[0] ?? null) : null;
}

export function firstMessageExecution(
  target: FirstMessageTarget,
  snapshot: Pick<HostSnapshot, "environments" | "executionPreferences" | "harnesses">,
): FirstMessageExecution {
  const placements = threadPlacementOptions(snapshot.environments, snapshot.harnesses);
  const runnable = placements.filter((placement) => placement.available);
  const remembered = lastExecutionSelection(snapshot.executionPreferences);
  const selection = composerExecutionSelection({
    chosen: null,
    defaultPlacement: startingPlacement(target, snapshot, runnable),
    placements,
    remembered,
  });
  const blocked = selection === null ? remembered : null;
  const placement = selection === null ? null : placementForSelection(placements, selection);
  return {
    accessMode: snapshot.executionPreferences.accessMode,
    accessReason:
      placement === null
        ? null
        : accessModeConflict(snapshot.executionPreferences.accessMode, placement),
    blocked,
    blockedPlacement:
      blocked === null
        ? null
        : (placements.find(
            (placement) =>
              placement.environmentId === blocked.environmentId &&
              placement.harnessInstanceId === blocked.harnessInstanceId,
          ) ?? null),
    placements,
    runnable,
    selection,
  };
}

/** The chosen model as the reader knows it, falling back to its own id. */
export function executionLabel(
  placements: readonly ThreadPlacementOption[],
  selection: ExecutionSelection,
): string {
  const placement = placements.find(
    (candidate) =>
      candidate.environmentId === selection.environmentId &&
      candidate.harnessInstanceId === selection.harnessInstanceId,
  );
  const model = placement?.models.find(
    (candidate) =>
      candidate.providerId === selection.modelSelection.providerId &&
      candidate.modelId === selection.modelSelection.modelId,
  );
  return model?.displayName ?? selection.modelSelection.modelId;
}

/**
 * Why a first message cannot be sent yet, or null when it can. `choose` is the
 * one reason sending itself can answer, by asking which AI; every other one is
 * waited out or fixed elsewhere.
 */
export interface FirstMessageBlocker {
  readonly choose: boolean;
  readonly reason: string;
}

export function firstMessageBlocker(input: {
  readonly attachmentsReady: boolean;
  /** Whether the Host is attached and has confirmed this reader. */
  readonly connected: boolean;
  /** A reason only Chat has: Home already runs on an AI nobody chose here. */
  readonly conflict: string | null;
  readonly execution: FirstMessageExecution;
  readonly target: FirstMessageTarget;
  readonly workspace: WorkspaceSummary | null;
}): FirstMessageBlocker | null {
  const wait = (reason: string): FirstMessageBlocker => ({ choose: false, reason });
  const { blocked, blockedPlacement, placements, runnable, selection } = input.execution;
  if (input.workspace === null) return wait("This workspace is no longer here.");
  if (input.workspace.status !== "ready") {
    return wait("Your workspace storage is still being prepared.");
  }
  if (!input.connected) return wait("Reconnect to send. What you write here is kept.");
  if (runnable.length === 0) {
    // An account getting ready, as one does after its computer starts, is
    // only a wait: naming it keeps the person from hunting for a fault. Their
    // own choice is the one they wait for; another getting ready would not
    // let them send.
    const preparing =
      blocked === null
        ? preparingPlacement(placements)
        : blockedPlacement?.availability === "preparing"
          ? blockedPlacement
          : null;
    if (preparing !== null) {
      return wait(
        `${accountGettingReady(preparing.accountName)}. You can send as soon as it is done. What you write here is kept.`,
      );
    }
    if (blockedPlacement !== null)
      return wait(`${blockedPlacement.accountName}: ${blockedPlacement.detail}`);
    if (blocked !== null)
      return wait("The chosen AI account is no longer here. Choose another AI to start.");
    // Accounts are connected on a computer or the web, never here.
    return wait(
      "Connect an AI account in Opensteer on your computer or the web to start. What you write here is kept.",
    );
  }
  if (input.conflict !== null) return wait(input.conflict);
  if (blockedPlacement !== null) {
    return {
      choose: true,
      reason:
        blockedPlacement.availability === "preparing"
          ? `${accountGettingReady(blockedPlacement.accountName)}. Wait for it, or choose another AI to start.`
          : blockedPlacement.available
            ? `${blockedPlacement.accountName} no longer offers ${blocked?.modelSelection.modelId}. Choose another model to start.`
            : `${blockedPlacement.accountName}: ${blockedPlacement.detail}. Choose another AI to start.`,
    };
  }
  if (selection === null) {
    return {
      choose: true,
      reason:
        input.target === "home"
          ? "Choose which AI runs Chat to start."
          : "Choose which AI runs this task to start.",
    };
  }
  if (input.execution.accessReason !== null) return wait(input.execution.accessReason);
  if (!input.attachmentsReady) return wait("Waiting for your files to finish uploading.");
  return null;
}

/**
 * Writes the message to this phone under the first message's own key, before
 * anything is asked of the Host, and reads back exactly what was written. The
 * files it carries leave the strip: they are the message's now.
 */
export async function claimFirstMessage(input: {
  readonly deploymentId: string;
  readonly draftKey: string;
  readonly drafts: ThreadDraftStore;
  readonly idempotencyKey: string;
  readonly quote: ThreadDraftQuote | null;
  readonly staged: DraftAttachments;
  readonly start?: PendingThreadStart;
  readonly text: string;
  readonly userId: string;
}): Promise<PendingCommand> {
  const carried = input.staged.items;
  const attachments = carried.flatMap((item) => {
    const part = draftAttachmentPart(item);
    return part === null ? [] : [part];
  });
  if (attachments.length !== carried.length) {
    throw new Error("Waiting for your files to finish uploading.");
  }
  await input.drafts.claimPending(input.deploymentId, input.userId, input.draftKey, {
    ...(attachments.length > 0
      ? { attachments, localUris: carried.map((item) => item.localUri) }
      : {}),
    idempotencyKey: input.idempotencyKey,
    // Only the source id travels: the Host resolves the quoted update under
    // this reader's authority, never from an excerpt.
    ...(input.quote === null ? {} : { quotedMessageId: input.quote.messageId }),
    ...(input.start === undefined ? {} : { start: input.start }),
    text: input.text,
    threadId: input.draftKey,
  });
  const claimed = input.drafts.readPending(input.deploymentId, input.userId, input.draftKey);
  if (claimed === null) throw new Error("Your message was not saved on this phone.");
  input.staged.release(carried.map(attachmentKey));
  return claimed;
}

/**
 * Hands a claimed first message to the Thread it started, whose composer
 * sends it as it opens, under the very same key.
 *
 * That Thread's composer will open, upload and delete these files under its
 * own id, so it gets copies of its own. Each copy names the same destination
 * every time and the originals are kept until the Thread holds the message: a
 * failure anywhere here is retried, not lost. Answers with the message as the
 * Thread now owes it.
 */
export async function handOverFirstMessage(input: {
  readonly claimed: PendingCommand;
  readonly deploymentId: string;
  readonly draftKey: string;
  readonly drafts: ThreadDraftStore;
  readonly files: FirstMessageAttachmentDraftScope;
  /** Leave the source once the destination is durable, before clearing its visible message. */
  readonly onReady?: () => void;
  readonly threadId: string;
  readonly userId: string;
}): Promise<PendingCommand> {
  const { claimed, deploymentId, drafts, threadId, userId } = input;
  const threadFiles: AttachmentDraftScope = { deploymentId, threadId, userId };
  const firstUris = claimed.localUris;
  const threadUris =
    firstUris === undefined ? undefined : await copyFiles(input.files, threadFiles, firstUris);
  await drafts.claimPending(deploymentId, userId, threadId, {
    ...(claimed.attachments === undefined
      ? {}
      : { attachments: claimed.attachments, localUris: threadUris }),
    idempotencyKey: claimed.idempotencyKey,
    ...(claimed.quotedMessageId === undefined ? {} : { quotedMessageId: claimed.quotedMessageId }),
    text: claimed.text,
    threadId,
  });
  // The Thread owes it now, so the first message's record has done its job,
  // and only the Thread's copies of the files are referenced from here on.
  const owed = drafts.readPending(deploymentId, userId, threadId);
  if (owed === null) throw new Error("Your message was not saved on this phone.");
  input.onReady?.();
  const cleared = await drafts.clearPending(
    deploymentId,
    userId,
    input.draftKey,
    claimed.idempotencyKey,
  );
  if (cleared) forgetDraftFiles(input.files, firstUris ?? []);
  return owed;
}

/**
 * The Thread's own copies of the files, in the message's order. One at a
 * time, so a phone low on space fails on one file rather than part of every
 * file. A null stays null: that file is the Host's alone and travels by
 * reference.
 */
async function copyFiles(
  from: FirstMessageAttachmentDraftScope,
  to: AttachmentDraftScope,
  localUris: readonly (string | null)[],
): Promise<(string | null)[]> {
  const copied: (string | null)[] = [];
  for (const localUri of localUris) {
    copied.push(
      localUri === null ? null : await copyFirstMessageDraftFileToThread(from, to, localUri),
    );
  }
  return copied;
}

export interface FirstMessageExample {
  readonly label: string;
  readonly text: string;
}

/**
 * The screen a first message is written on: what to ask, above, scrolling;
 * the composer docked below, where every later message is written too.
 */
export function FirstMessageComposer(props: {
  /** Opens the keyboard as it appears: set where writing is why it opened. */
  readonly autoFocus?: boolean;
  readonly blocker: FirstMessageBlocker | null;
  /** What scrolls above the composer: the invitation, examples and notices. */
  readonly children: ReactNode;
  readonly held: boolean;
  readonly execution: FirstMessageExecution;
  readonly inputRef: RefObject<TextInputInstance | null>;
  readonly onChangeText: (text: string) => void;
  readonly onChooseAI: (pickerAttemptId?: string, conversation?: boolean) => void;
  readonly onSend: (selection: ExecutionSelection | null) => void;
  readonly placeholder: string;
  readonly quote: ThreadDraftQuote | null;
  readonly onRemoveQuote: () => void;
  /** Attachment identities in this phone's shared, saved draft. */
  readonly savedAttachmentKeys: readonly string[];
  readonly selectionLabel: string;
  readonly sending: boolean;
  readonly staged: DraftAttachments;
  readonly text: string;
  /** Set where a transparent navigation bar lies over the top of the screen. */
  readonly underHeader: boolean;
  /** Chat's first message: voice can say it, and it creates Chat. */
  readonly voice?: boolean;
  /** Whose dismissals of a usage-limit line apply here. */
  readonly usageScope: { readonly deploymentId: string; readonly userId: string };
}): ReactNode {
  const gutter = useGutter();
  const column = useReadingColumn();
  const headerHeight = useHeaderHeight();
  const insets = useContentInsets();
  const { fontScale } = useWindowDimensions();
  const keyboardVisible = useKeyboardVisible();
  const { blocker, held, sending, staged } = props;
  const selection = props.execution.selection ?? props.execution.blocked;
  const placement =
    selection === null ? null : placementForSelection(props.execution.placements, selection);
  const model =
    placement?.models.find(
      (m) =>
        m.providerId === selection?.modelSelection.providerId &&
        m.modelId === selection.modelSelection.modelId,
    ) ?? null;
  const written = props.text.trim() !== "" || staged.items.length > 0;
  // A quote alone is a reference, not a message: the durable record refuses
  // one, so Send waits for words or a file to go with it. When the only thing
  // missing is which AI to start on, Send asks that rather than standing dead.
  const actionable = written && !held && !sending && (blocker === null || blocker.choose);
  const voiceReady = useVoiceAvailable() && props.voice === true;

  // Only the outcome of the picker opened by this Send may finish it. A later
  // preference update, including one from another screen or device, cannot.
  const focused = useIsFocused();
  const pickerAttempt = useRef<string | null>(null);
  const readySelection = useRef<ExecutionSelection | null>(null);
  const attemptedContent = useRef<string | null>(null);
  const attemptedSavedAttachments = useRef<string | null>(null);
  const attemptedStagedAttachments = useRef<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<ExecutionSelection | null>(null);
  const stagedKeys = JSON.stringify(staged.items.map(attachmentKey));
  const savedKeys = JSON.stringify(props.savedAttachmentKeys);
  const content = JSON.stringify([props.text, props.quote?.messageId ?? null, stagedKeys]);
  useEffect(() => {
    if (attemptedContent.current === null) return;
    const savedChanged =
      savedKeys !== attemptedSavedAttachments.current &&
      savedKeys !== attemptedStagedAttachments.current;
    if (attemptedContent.current === content && !savedChanged) return;
    if (pickerAttempt.current !== null) {
      cancelFirstMessagePickerAttempt(pickerAttempt.current);
      pickerAttempt.current = null;
    }
    attemptedContent.current = null;
    attemptedSavedAttachments.current = null;
    attemptedStagedAttachments.current = null;
    readySelection.current = null;
    setPendingSelection(null);
  }, [content, savedKeys]);
  useEffect(() => {
    if (pendingSelection === null || blocker === null || blocker.choose) return;
    attemptedContent.current = null;
    attemptedSavedAttachments.current = null;
    attemptedStagedAttachments.current = null;
    readySelection.current = null;
    setPendingSelection(null);
  }, [blocker, pendingSelection]);
  const readyToSend =
    focused &&
    pendingSelection !== null &&
    actionable &&
    (blocker === null || blocker.choose) &&
    staged.items.every((item) => draftAttachmentPart(item) !== null);
  const { onSend } = props;
  useEffect(() => {
    const selection = readySelection.current;
    if (!readyToSend || selection === null) return;
    attemptedContent.current = null;
    attemptedSavedAttachments.current = null;
    attemptedStagedAttachments.current = null;
    readySelection.current = null;
    setPendingSelection(null);
    onSend(selection);
  }, [onSend, readyToSend]);
  useEffect(
    () => () => {
      if (pickerAttempt.current !== null) {
        cancelFirstMessagePickerAttempt(pickerAttempt.current);
        pickerAttempt.current = null;
      }
      readySelection.current = null;
      attemptedContent.current = null;
      attemptedSavedAttachments.current = null;
      attemptedStagedAttachments.current = null;
    },
    [],
  );
  const withdrawSend = (): void => {
    if (pickerAttempt.current !== null) {
      cancelFirstMessagePickerAttempt(pickerAttempt.current);
      pickerAttempt.current = null;
    }
    readySelection.current = null;
    attemptedContent.current = null;
    attemptedSavedAttachments.current = null;
    attemptedStagedAttachments.current = null;
    setPendingSelection(null);
  };
  const chooseThenSend = (): void => {
    withdrawSend();
    const attempt = beginFirstMessagePickerAttempt();
    pickerAttempt.current = attempt.id;
    attemptedContent.current = content;
    attemptedSavedAttachments.current = savedKeys;
    attemptedStagedAttachments.current = stagedKeys;
    void attempt.result.then((selection) => {
      if (pickerAttempt.current !== attempt.id) return;
      pickerAttempt.current = null;
      readySelection.current = selection;
      if (selection === null) {
        attemptedContent.current = null;
        attemptedSavedAttachments.current = null;
        attemptedStagedAttachments.current = null;
      }
      setPendingSelection(selection);
    });
    props.onChooseAI(attempt.id);
  };
  const changeText = (text: string): void => {
    withdrawSend();
    props.onChangeText(text);
  };
  const chooseManually = (): void => {
    withdrawSend();
    props.onChooseAI();
  };
  const menuOptions: readonly NativeMenuOption[] = [
    {
      disabled: held,
      icon: "paperclip",
      id: "attach-file",
      label: "Attach file…",
      onPress: () => void staged.pick("file"),
    },
    {
      disabled: held,
      icon: "photo",
      id: "attach-photo",
      label: "Attach photo…",
      onPress: () => void staged.pick("photo"),
    },
    { icon: "gearshape", id: "model", label: "Choose AI…", onPress: chooseManually },
  ];
  const fieldMaxHeight =
    type.body.lineHeight * 6 * Math.min(fontScale, controlFontScaleLimit) + space[8] * 2;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.fill}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          column,
          {
            paddingLeft: gutter + insets.left,
            paddingRight: gutter + insets.right,
            paddingTop: (props.underHeader ? headerHeight : 0) + space[24],
          },
        ]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {props.children}
      </ScrollView>

      <View
        style={[
          styles.dock,
          column,
          {
            paddingBottom: (keyboardVisible ? 0 : insets.bottom) + space[8],
            paddingLeft: space[8] + insets.left,
            paddingRight: space[8] + insets.right,
          },
        ]}
      >
        {props.quote === null ? null : (
          <View accessibilityLabel="Quoted update" style={styles.quote}>
            <View style={styles.grow}>
              <AppText numberOfLines={1} role="secondaryMedium">
                {props.quote.attribution}
              </AppText>
              <AppText numberOfLines={2} role="secondary" tone="muted">
                {props.quote.excerpt}
              </AppText>
            </View>
            <Pressable
              accessibilityLabel="Remove quote"
              accessibilityRole="button"
              hitSlop={space[8]}
              onPress={props.onRemoveQuote}
              style={styles.quoteRemove}
            >
              <AppText role="secondaryMedium" tone="muted">
                Remove
              </AppText>
            </Pressable>
          </View>
        )}
        <AttachmentStrip
          disabled={held}
          items={staged.items}
          notice={staged.notice}
          onRemove={staged.remove}
          onRetry={staged.retry}
        />
        {blocker === null ? null : (
          <AppText role="caption" style={styles.reason} tone="muted">
            {blocker.reason}
          </AppText>
        )}
        <VoiceDock />
        <ComposerBar
          accessory={
            <ComposerPills
              accessMode={props.execution.accessMode}
              accessModes={placement?.accessModes ?? null}
              disabledReason={held || sending ? "Wait for the current change to finish." : null}
              blockedReason={
                props.execution.accessReason ??
                (props.execution.blocked === null ? null : props.blocker?.reason)
              }
              driverKind={placement?.driverKind}
              engineName={
                placement?.engineName ??
                (selection === null ? "Choose engine" : "Unavailable engine")
              }
              model={model}
              modelLabel={props.selectionLabel}
              modelOptions={selection?.modelSelection.options ?? {}}
              onOpenModel={chooseManually}
              onPresent={noop}
            />
          }
          action={
            // With nothing typed the circle is voice where it exists, as in a
            // thread's own bar, rather than a Send that cannot be pressed.
            voiceReady && !written ? (
              <VoiceMic disabled={held} face="disc" />
            ) : (
              <ComposerAction
                busy={sending}
                disabled={!actionable}
                kind="send"
                label={
                  sending ? "Sending" : blocker?.choose === true ? "Choose an AI" : "Send message"
                }
                onPress={() => {
                  if (blocker?.choose === true) chooseThenSend();
                  else props.onSend(null);
                }}
              />
            )
          }
          field={
            <Pressable
              accessible={false}
              onPress={() => props.inputRef.current?.focus()}
              style={styles.lane}
            >
              <TextInput
                accessibilityLabel="Message"
                autoFocus={props.autoFocus}
                cursorColor={color.ember}
                editable={!held}
                maxFontSizeMultiplier={controlFontScaleLimit}
                multiline
                onChangeText={changeText}
                placeholder={props.placeholder}
                placeholderTextColor={color.muted}
                ref={props.inputRef}
                selectionColor={color.ember}
                style={[styles.input, { maxHeight: fieldMaxHeight }]}
                value={props.text}
              />
            </Pressable>
          }
          leading={
            <NativeMenu
              accessibilityHint="Attach files or choose which AI this starts on"
              accessibilityLabel="Message actions"
              onPresent={noop}
              onSettle={noop}
              options={menuOptions}
            >
              <ComposerGlyph icon="plus" />
            </NativeMenu>
          }
          shape="rounded"
        />
        <UsageNotice
          notice={usageLimitNotice({
            placements: props.execution.placements,
            scope: props.usageScope,
            selection: props.execution.selection,
          })}
          onOpen={chooseManually}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function noop(): void {}

/** The large question a first message answers, and a line on what happens to it. */
export function FirstMessageInvitation(props: {
  readonly detail: string;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.invitation}>
      <AppText role="displayLarge">{props.title}</AppText>
      <AppText role="secondary" tone="muted">
        {props.detail}
      </AppText>
    </View>
  );
}

/**
 * Ways to begin, each a sentence the reader can send or edit. They are only
 * ever put into the field: nothing is sent until the reader sends it.
 */
export function FirstMessageExamples(props: {
  readonly examples: readonly FirstMessageExample[];
  readonly onPick: (text: string) => void;
}): ReactNode {
  return (
    <View style={styles.examples}>
      {props.examples.map((example) => (
        <Pressable
          accessibilityHint="Puts this in the message field to edit or send"
          accessibilityRole="button"
          key={example.label}
          onPress={() => props.onPick(example.text)}
          style={({ pressed }) => [styles.example, pressed && styles.pressed]}
        >
          <Symbol name="sparkles" size={16} tint={color.ember} />
          <AppText role="secondary" style={styles.grow}>
            {example.label}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The message already handed to the Host under a key it may have accepted. It
 * is never re-keyed and never edited; only Send again sends it, as it was.
 */
export function FirstMessageHeld(props: {
  /** Null where sending it again would need a decision first. */
  readonly onRetry: (() => void) | null;
  readonly sending: boolean;
  readonly status: string;
  readonly text: string;
}): ReactNode {
  return (
    <View style={styles.held}>
      {props.text === "" ? null : <AppText role="secondary">{props.text}</AppText>}
      <View style={styles.heldFoot}>
        <AppText role="caption" style={styles.grow} tone="muted">
          {props.sending ? "Sending…" : props.status}
        </AppText>
        {props.onRetry === null ? null : (
          <SecondaryButton
            compact
            disabled={props.sending}
            label="Send again"
            onPress={props.onRetry}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: space[16], paddingBottom: space[24] },
  dock: { gap: space[8], paddingTop: space[8] },
  example: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[8],
    paddingHorizontal: space[14],
    paddingVertical: space[12],
  },
  examples: { gap: space[10] },
  fill: { flex: 1 },
  grow: { flex: 1 },
  held: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    gap: space[8],
    padding: space[12],
  },
  heldFoot: { alignItems: "center", flexDirection: "row", gap: space[12] },
  input: {
    color: color.text,
    fontSize: type.body.fontSize,
    fontWeight: type.body.fontWeight,
    includeFontPadding: false,
    paddingHorizontal: 0,
    paddingVertical: space[8],
    textAlignVertical: "top",
  },
  // A generous start: the invitation sits in the upper third, where the eye
  // lands, and the composer stays where every later message is written.
  invitation: { gap: space[10], paddingTop: space[32] },
  lane: { flex: 1, justifyContent: "center", minHeight: composerLaneHeight },
  pressed: { backgroundColor: color.surfacePressed },
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
  quoteRemove: { alignItems: "center", justifyContent: "center", minHeight: touchTarget },
  reason: { paddingHorizontal: space[12] },
});
