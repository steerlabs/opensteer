import { editingTextMaxLength, type EditingContext } from "@opensteer/protocol/editing";
import {
  createEditingState,
  editingRefusalMessages,
  reduceEditing,
  type EditingProxyEvent,
  type EditingOperation,
  type EditingProxyInstruction,
  type EditingTargetAbilities,
} from "@opensteer/client/editing";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Platform, View } from "react-native";
import { AppText } from "../../../src/ui/primitives.js";
const RemoteTextInput = lazy(async () => ({
  default: (await import("./remote-text-input.js")).RemoteTextInput,
}));
const noKeyboardReplacements = { keyboardMayReplaceText: false } as const;

const nativeBrowserAbilities: EditingTargetAbilities = {
  composition: true,
  rangeEdits: true,
  commands: true,
  clipboard: "full",
};

export interface NativeEditingProxyHandle {
  cancel(): void;
  interrupt(type?: "pointerdown" | "blur"): void;
  refused(operation: EditingOperation): void;
}

/** Browser, phone and Mac viewers feed the same native event adapter. */
/** CZ6: what the person is told of a late paste too large for one operation. */
export const lateTooLarge =
  "This paste is too large to send while the field changes. Paste it again.";
export function NativeEditingProxy({
  context,
  focused = context?.field != null,
  softKeyboard = true,
  sendOperation,
  sendOperations,
  onDone,
  cancelCompositionOnBlur = false,
  abilities = nativeBrowserAbilities,
  label = "Type into the page",
  ref,
}: {
  readonly context: EditingContext | null;
  readonly focused?: boolean;
  readonly softKeyboard?: boolean;
  readonly sendOperation: (operation: EditingOperation) => boolean;
  /** P2: sends a dependent operation group in one atomic batch on display targets. */
  readonly sendOperations?: (operations: readonly EditingOperation[]) => boolean;
  readonly cancelCompositionOnBlur?: boolean;
  readonly onDone: () => void;
  readonly abilities?: EditingTargetAbilities;
  readonly label?: string;
  readonly ref?: Ref<NativeEditingProxyHandle>;
}) {
  const { step, late } = useMemo(() => {
    let state = createEditingState(Platform.OS === "ios" ? "ios" : "android", abilities);
    /**
     * The contexts lately left, as the reducer had each: their late events are reduced there.
     * The page can move on more than once while the native field still works through what was
     * typed before; a bound, not a policy.
     */
    const retired = new Map<string, typeof state>();
    return {
      /** The context the reducer is in now. */
      step: (event: EditingProxyEvent) => {
        if (
          event.type === "context" &&
          state.context &&
          event.context?.contextId !== state.context.contextId
        ) {
          // The context change commits an open composition: in the context left it has ended. A
          // composition an earlier context left is that context's, not this one's: this one's
          // mirror, cleared by the native field at its configure, begins blank.
          const left = state.context.contextId;
          const own = state.composition?.contextId === left;
          // CZ2: only a composition still open is committed by the change (CY4); one a tap, a
          // blur or a refusal already ended keeps its end, with no commit to come.
          const { committed: _ended, ...composition } = state.composition ?? {};
          retired.set(
            left,
            own
              ? {
                  ...state,
                  composition: state.composition!.detached
                    ? (composition as NonNullable<typeof state.composition>)
                    : { ...state.composition!, detached: true, committed: state.composition!.text },
                }
              : state.composition
                ? {
                    ...state,
                    composition: null,
                    proxy: { value: "", selectionStart: 0, selectionEnd: 0 },
                    caret: 0,
                    resetPending: false,
                  }
                : state,
          );
          if (retired.size > 16) retired.delete(retired.keys().next().value!);
        }
        const result = reduceEditing(state, event);
        state = result.state;
        return result;
      },
      late: (contextId: string, event: EditingProxyEvent) => {
        const previous = retired.get(contextId);
        if (!previous) return null;
        const result = reduceEditing(previous, event);
        retired.set(contextId, result.state);
        return result;
      },
    };
  }, [abilities]);
  /**
   * CY8, CZ6: what the late path sends of an operation, under the context it was made in: an edit
   * or a composition as it is, a command with its late reducer's context (stamped there, CZ3), a
   * plain paste as one insertion of its text, a key not at all (it would land in whatever has
   * focus now). Never part of a paste: one larger than one operation may carry is refused whole
   * (null), and the person pastes again.
   */
  const lateOperations = (
    operation: EditingOperation,
    contextId: string,
  ): EditingOperation[] | null => {
    if (operation.kind === "edit" || operation.kind === "command") return [operation];
    // CZ12: a composition is not relative to the caret: the page refuses it under an earlier
    // context, so it is not sent (and its reducer hears it never went, below).
    if (operation.kind === "compose") return [];
    if (operation.kind !== "paste") return [];
    const item = operation.items.find((candidate) => candidate.type === "text/plain");
    if (!item) return [];
    const text = new TextDecoder().decode(item.bytes);
    if (text.length > editingTextMaxLength) return null;
    return [
      {
        kind: "edit",
        edit: { contextId, text, before: "", after: "" },
        ...(operation.follows ? { follows: true as const } : {}),
      },
    ];
  };
  /**
   * CY8, P2: the one send of both paths. When `sendOperations` is supplied (display targets),
   * a leading operation and any immediately following `follows: true` operations are delivered
   * together as one atomic group. At the first refusal, the reducer is told and nothing after goes.
   */
  const send = (
    operations: readonly EditingOperation[],
    refused: (operation: EditingOperation) => void,
  ): boolean => {
    if (sendOperations && operations.some((op) => "follows" in op && op.follows)) {
      for (let i = 0; i < operations.length;) {
        const group: EditingOperation[] = [operations[i]!];
        i++;
        while (i < operations.length) {
          const next = operations[i]!;
          if (!("follows" in next && next.follows)) break;
          group.push(next);
          i++;
        }
        const ok = group.length === 1 ? sendOperation(group[0]!) : sendOperations(group);
        if (!ok) {
          for (const op of group) refused(op);
          setRefusal("Editing refused. Waiting for the remote field.");
          return false;
        }
      }
      return true;
    }
    for (const operation of operations)
      if (!sendOperation(operation)) {
        refused(operation);
        setRefusal("Editing refused. Waiting for the remote field.");
        return false;
      }
    return true;
  };
  const latest = useRef({ sendOperation, onDone, send });
  latest.current = { sendOperation, onDone, send };
  const nativeComposing = useRef(false);
  const [finishCompositionRequest, requestFinish] = useState(0);
  const [instruction, setInstruction] = useState<EditingProxyInstruction>({});
  const [preedit, setPreedit] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      cancel() {
        step({ type: "context", context: null });
        nativeComposing.current = false;
        setPreedit("");
        setInstruction({});
      },
      interrupt(type = "pointerdown") {
        const result = step({ type });
        latest.current.send(result.operations, (operation) => step({ type: "refused", operation }));
        setInstruction(result.instruction);
        if (nativeComposing.current) requestFinish((previous) => previous + 1);
        setPreedit("");
      },
      refused(operation: EditingOperation) {
        const result = step({ type: "refused", operation });
        if (result.instruction.set) setInstruction(result.instruction);
      },
    }),
    [step],
  );
  // CZ9: in the commit itself, so the context left is retired before any packet of it can reach
  // the view under the new one (a passive effect left a window after the commit).
  useLayoutEffect(() => {
    const result = step({ type: "context", context });
    // Native configure owns the old composition ending and the new context's reset.
    setInstruction({});
    setPreedit("");
    latest.current.send(result.operations, (operation) => step({ type: "refused", operation }));
  }, [context, step]);
  useEffect(
    () => () => {
      for (const operation of step({ type: "blur" }).operations)
        latest.current.sendOperation(operation);
    },
    [step],
  );
  return (
    <View style={{ flex: 1, minHeight: 44 }}>
      <Suspense fallback={null}>
        <RemoteTextInput
          accessibilityLabel={label}
          context={context}
          focused={focused}
          softKeyboard={softKeyboard}
          {...(abilities.rangeEdits ? undefined : noKeyboardReplacements)}
          instruction={instruction}
          finishCompositionRequest={finishCompositionRequest}
          onError={() => setRefusal("Native input unavailable. Reopen the keyboard to retry.")}
          onLateEvent={(contextId, event) => {
            // CV1: what the person did in the context just left still goes, under that context:
            // the page applies what is relative to its caret (an insertion, a backward deletion, a
            // move) in the same field and refuses anything else alone. Only what names its context
            // leaves: an edit or a composition, a paste as the text it inserts, and a command; a key
            // would land in whatever has focus now.
            const result = late(contextId, event);
            if (!result) return null;
            // The native field composes or not whatever the context: the same bookkeeping.
            if (
              event.type === "compositionstart" ||
              event.type === "compositionupdate" ||
              (event.type === "input" && event.composing)
            )
              nativeComposing.current = true;
            else if (event.type === "compositionend") nativeComposing.current = false;
            for (const operation of result.operations)
              if (operation.kind === "compose") late(contextId, { type: "refused", operation });
            const pieces = result.operations.map((operation) =>
              lateOperations(operation, contextId),
            );
            if (pieces.includes(null)) {
              setRefusal(lateTooLarge);
              return { preventDefault: true };
            }
            const operations = pieces.flatMap((each) => each!);
            if (!send(operations, (operation) => late(contextId, { type: "refused", operation })))
              return { preventDefault: true };
            return result.instruction;
          }}
          onEvent={(event) => {
            if (
              event.type === "compositionstart" ||
              event.type === "compositionupdate" ||
              (event.type === "input" && event.composing)
            )
              nativeComposing.current = true;
            else if (event.type === "compositionend" || event.type === "blur")
              nativeComposing.current = false;
            if (event.type === "blur" && cancelCompositionOnBlur)
              step({ type: "context", context: null });
            const result = step(event);
            if (!abilities.composition && !context?.field?.sensitive) {
              if (event.type === "compositionupdate") setPreedit(event.data);
              else if (["compositionend", "blur", "pointerdown"].includes(event.type))
                setPreedit("");
            }
            // A refused one never left: a composition it carried goes again as a fresh start.
            if (!send(result.operations, (operation) => step({ type: "refused", operation })))
              return { preventDefault: true };
            if (
              nativeComposing.current &&
              result.operations.some((operation) => operation.kind !== "compose")
            )
              requestFinish((previous) => previous + 1);
            setRefusal(result.refusal ? editingRefusalMessages[result.refusal] : null);
            if (event.type === "blur") onDone();
            return result.instruction;
          }}
          style={{ flex: 1, minHeight: 44 }}
        />
      </Suspense>
      {preedit ? <AppText>{preedit}</AppText> : null}
      {refusal ? <AppText>{refusal}</AppText> : null}
    </View>
  );
}
