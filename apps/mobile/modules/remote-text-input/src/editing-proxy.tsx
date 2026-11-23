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
}

/** Browser, phone and Mac viewers feed the same native event adapter. */
export function NativeEditingProxy({
  context,
  focused = context?.field != null,
  softKeyboard = true,
  sendOperation,
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
  readonly cancelCompositionOnBlur?: boolean;
  readonly onDone: () => void;
  readonly abilities?: EditingTargetAbilities;
  readonly label?: string;
  readonly ref?: Ref<NativeEditingProxyHandle>;
}) {
  const { step, late, current } = useMemo(() => {
    let state = createEditingState(Platform.OS === "ios" ? "ios" : "android", abilities);
    /**
     * The contexts lately left, as the reducer had each: their late events are reduced there.
     * The page can move on more than once while the native field still works through what was
     * typed before; a bound, not a policy.
     */
    const retired = new Map<string, typeof state>();
    return {
      /** The context the reducer is in now. */
      current: () => state.context?.contextId,
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
          retired.set(
            left,
            own
              ? {
                  ...state,
                  composition: {
                    ...state.composition!,
                    detached: true,
                    // The change commits its text to the page (CY4).
                    committed: state.composition!.text,
                  },
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
   * A command says the context of the field it was made for: the reducer's, the current one or
   * a retired one on the late path. (The transport stamps any command that arrives without one.)
   */
  const scoped = (operation: EditingOperation, contextId = current()): EditingOperation =>
    operation.kind === "command" && contextId ? { ...operation, contextId } : operation;
  /**
   * CY8: what the late path sends of an operation, under the context it was made in: an edit or a
   * composition as it is, a command with that context, a plain paste as the text it inserts (in
   * insertions within the protocol's limit, in order: insertions compose, split between code
   * points), a key not at all (it would land in whatever has focus now).
   */
  const lateOperations = (operation: EditingOperation, contextId: string): EditingOperation[] => {
    if (operation.kind === "edit" || operation.kind === "compose") return [operation];
    if (operation.kind === "command") return [scoped(operation, contextId)];
    if (operation.kind !== "paste") return [];
    const item = operation.items.find((candidate) => candidate.type === "text/plain");
    if (!item) return [];
    const parts: string[] = [""];
    for (const point of new TextDecoder().decode(item.bytes)) {
      if (parts.at(-1)!.length + point.length > editingTextMaxLength) parts.push("");
      parts[parts.length - 1] += point;
    }
    return parts
      .filter((text) => text !== "")
      .map((text) => ({ kind: "edit", edit: { contextId, text, before: "", after: "" } }));
  };
  /**
   * CY8: the one send of both paths. Each operation in order; at the first the transport refuses,
   * the reducer it came from is told (the current one, or the late one of its context), nothing
   * after it goes, and the person sees the refusal.
   */
  const send = (
    operations: EditingOperation[],
    refused: (operation: EditingOperation) => void,
  ): boolean => {
    for (const operation of operations)
      if (!sendOperation(operation)) {
        refused(operation);
        setRefusal("Editing refused. Waiting for the remote field.");
        return false;
      }
    return true;
  };
  const latest = useRef({ sendOperation, onDone, scoped, send });
  latest.current = { sendOperation, onDone, scoped, send };
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
        latest.current.send(
          result.operations.map((operation) => latest.current.scoped(operation)),
          (operation) => step({ type: "refused", operation }),
        );
        setInstruction(result.instruction);
        if (nativeComposing.current) requestFinish((previous) => previous + 1);
        setPreedit("");
      },
    }),
    [step],
  );
  useEffect(() => {
    const result = step({ type: "context", context });
    // Native configure owns the old composition ending and the new context's reset.
    setInstruction({});
    setPreedit("");
    latest.current.send(
      result.operations.map((operation) => latest.current.scoped(operation)),
      (operation) => step({ type: "refused", operation }),
    );
  }, [context, step]);
  useEffect(
    () => () => {
      for (const operation of step({ type: "blur" }).operations)
        latest.current.sendOperation(latest.current.scoped(operation));
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
            const operations = result.operations.flatMap((operation) =>
              lateOperations(operation, contextId),
            );
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
            if (
              !send(
                result.operations.map((operation) => scoped(operation)),
                (operation) => step({ type: "refused", operation }),
              )
            )
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
