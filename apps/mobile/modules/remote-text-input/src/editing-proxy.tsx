import type { EditingContext } from "@opensteer/protocol/editing";
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
  const { step, late } = useMemo(() => {
    let state = createEditingState(Platform.OS === "ios" ? "ios" : "android", abilities);
    /**
     * The contexts lately left, as the reducer had each: their late events are reduced there.
     * The page can move on more than once while the native field still works through what was
     * typed before; a bound, not a policy.
     */
    const retired = new Map<string, typeof state>();
    return {
      step: (event: EditingProxyEvent) => {
        if (
          event.type === "context" &&
          state.context &&
          event.context?.contextId !== state.context.contextId
        ) {
          // The context change commits an open composition: in the context left it has ended.
          retired.set(
            state.context.contextId,
            state.composition
              ? { ...state, composition: { ...state.composition, detached: true } }
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
  const latest = useRef({ sendOperation, onDone });
  latest.current = { sendOperation, onDone };
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
        for (const operation of result.operations) latest.current.sendOperation(operation);
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
    for (const operation of result.operations) latest.current.sendOperation(operation);
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
            // CV1: what the person typed in the context just left still goes, under that context:
            // the page takes an insertion of the same field at its caret and refuses the rest
            // alone. Only what names its context leaves (an edit or a composition; a paste as the
            // text it inserts); a caret command or a key would land in whatever has focus now.
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
            for (const operation of result.operations) {
              const text =
                operation.kind === "paste"
                  ? operation.items.find((item) => item.type === "text/plain")
                  : null;
              if (operation.kind === "edit" || operation.kind === "compose")
                sendOperation(operation);
              else if (text)
                sendOperation({
                  kind: "edit",
                  edit: {
                    contextId,
                    text: new TextDecoder().decode(text.bytes),
                    before: "",
                    after: "",
                  },
                });
            }
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
            for (const operation of result.operations)
              if (!sendOperation(operation)) {
                // It never left: a composition it carried goes again as a fresh start.
                step({ type: "refused", operation });
                setRefusal("Editing refused. Waiting for the remote field.");
                return { preventDefault: true };
              }
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
