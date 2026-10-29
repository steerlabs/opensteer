import type { EditingContext } from "@opensteer/protocol/editing";
import {
  createEditingState,
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

const nativeBrowserAbilities: EditingTargetAbilities = {
  composition: true,
  rangeEdits: true,
  commands: true,
  clipboard: "full",
};

export interface NativeEditingProxyHandle {
  interrupt(type?: "pointerdown" | "blur"): void;
}

/** Browser, phone and Mac viewers feed the same native event adapter. */
export function NativeEditingProxy({
  context,
  sendOperation,
  onDone,
  abilities = nativeBrowserAbilities,
  label = "Type into the page",
  ref,
}: {
  readonly context: EditingContext | null;
  readonly sendOperation: (operation: EditingOperation) => boolean;
  readonly onDone: () => void;
  readonly abilities?: EditingTargetAbilities;
  readonly label?: string;
  readonly ref?: Ref<NativeEditingProxyHandle>;
}) {
  const step = useMemo(() => {
    let state = createEditingState(Platform.OS === "ios" ? "ios" : "android", abilities);
    return (event: EditingProxyEvent) => {
      const result = reduceEditing(state, event);
      state = result.state;
      return result;
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
          focused={context?.field != null}
          instruction={instruction}
          finishCompositionRequest={finishCompositionRequest}
          onError={() => setRefusal("Native input unavailable. Reopen the keyboard to retry.")}
          onEvent={(event) => {
            if (
              event.type === "compositionstart" ||
              event.type === "compositionupdate" ||
              (event.type === "input" && event.composing)
            )
              nativeComposing.current = true;
            else if (event.type === "compositionend" || event.type === "blur")
              nativeComposing.current = false;
            const result = step(event);
            if (!abilities.composition && !context?.field?.sensitive) {
              if (event.type === "compositionupdate") setPreedit(event.data);
              else if (["compositionend", "blur", "pointerdown"].includes(event.type))
                setPreedit("");
            }
            for (const operation of result.operations)
              if (!sendOperation(operation)) {
                setRefusal("Editing refused. Waiting for the remote field.");
                return { preventDefault: true };
              }
            if (
              nativeComposing.current &&
              result.operations.some((operation) => operation.kind !== "compose")
            )
              requestFinish((previous) => previous + 1);
            setRefusal(result.refusal ? `Editing refused: ${result.refusal}` : null);
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
