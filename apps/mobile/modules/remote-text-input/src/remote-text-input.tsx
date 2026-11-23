import type { EditingProxyEvent, EditingProxyInstruction } from "@opensteer/client/editing";
import type { EditingContext } from "@opensteer/protocol/editing";
import { requireNativeView } from "expo";
import { useCallback, useEffect, useRef, useState, type Ref, type ReactNode } from "react";
import type { ViewProps } from "react-native";
import { viewFunctionsOf, viewTagModule } from "../../../src/platform/view-functions.js";
import { decodeNativeEvent, nativeInstruction } from "./events.js";
interface NativeProxy {
  finishComposition(): Promise<void>;
  respond(instruction: EditingProxyInstruction & { id: number }): Promise<void>;
}
/**
 * The input's functions, called so the JavaScript thread never waits for the main thread: by its
 * tag on an iOS binary that offers it, as its own functions elsewhere (`viewFunctionsOf`).
 */
function proxyFunctions(instance: NativeProxy | null): NativeProxy | null {
  return viewFunctionsOf(viewTagModule("RemoteTextInput"), instance as never, [
    "finishComposition",
    "respond",
  ]) as NativeProxy | null;
}
const NativeInput = requireNativeView<
  ViewProps & {
    ref?: Ref<NativeProxy>;
    context: EditingContext | null;
    focused: boolean;
    softKeyboard: boolean;
    keyboardMayReplaceText?: boolean;
    onProxyEvent: (event: { nativeEvent: unknown }) => void;
  }
>("RemoteTextInput");
export function RemoteTextInput(
  props: ViewProps & {
    readonly context: EditingContext | null;
    readonly focused: boolean;
    readonly softKeyboard?: boolean;
    readonly keyboardMayReplaceText?: boolean;
    readonly onEvent: (event: EditingProxyEvent) => EditingProxyInstruction;
    /**
     * An event of the context just left, still arriving in the native field's order (CV1):
     * reduced as of that context, or nothing when it is not the one just left.
     */
    readonly onLateEvent?: (
      contextId: string,
      event: EditingProxyEvent,
    ) => EditingProxyInstruction | null;
    readonly onError: () => void;
    readonly instruction?: EditingProxyInstruction;
    readonly finishCompositionRequest?: number;
  },
): ReactNode {
  const {
    context,
    focused,
    softKeyboard = true,
    onEvent,
    onLateEvent,
    onError,
    instruction,
    finishCompositionRequest,
    ...viewProps
  } = props;
  const ref = useRef<NativeProxy>(null);
  const last = useRef(0);
  const error = useRef(onError);
  error.current = onError;
  const mounted = useRef(true);
  const [ready, setReady] = useState(false);
  const failed = useCallback((view: NativeProxy) => {
    if (mounted.current && ref.current === view) error.current();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const view = ref.current;
    if (ready && view && instruction?.set)
      void proxyFunctions(view)
        ?.respond(nativeInstruction(0, instruction))
        .catch(() => failed(view));
  }, [ready, instruction, failed]);
  useEffect(() => {
    const view = ref.current;
    if (ready && view && finishCompositionRequest)
      void proxyFunctions(view)
        ?.finishComposition()
        .catch(() => failed(view));
  }, [ready, finishCompositionRequest, failed]);
  return (
    <NativeInput
      {...viewProps}
      ref={ref}
      context={context}
      focused={focused}
      softKeyboard={softKeyboard}
      onLayout={(event) => {
        setReady(true);
        viewProps.onLayout?.(event);
      }}
      onProxyEvent={(event) => {
        const view = ref.current;
        if (!mounted.current || !view) return;
        try {
          const packet = decodeNativeEvent(event.nativeEvent);
          if (packet.id !== last.current + 1)
            throw new Error("Native editing events arrived out of order.");
          last.current = packet.id;
          const old =
            packet.contextId !== undefined && packet.contextId !== (context?.contextId ?? null);
          // A composition of the context just left ends in both: there, so what comes after it in
          // that context is taken; here, where the change left it ended. A key's release and a
          // blur are the field's whatever its context; a blur also clears the mirror the native
          // field still holds for the context left, which that context must know (CY9).
          const ended =
            old && (packet.event.type === "compositionend" || packet.event.type === "blur")
              ? onLateEvent?.(packet.contextId!, packet.event)
              : null;
          const current =
            old && !["compositionend", "keyup", "blur"].includes(packet.event.type)
              ? (onLateEvent?.(packet.contextId!, packet.event) ?? { preventDefault: true })
              : onEvent(packet.event);
          // The native field still holds the mirror of the context left: what that context's
          // reducer answers is what it applies (a commit there clears it), or the next letter
          // there carries what was committed again (found by regime C's commit promise).
          const instruction = ended ?? current;
          void proxyFunctions(view)
            ?.respond(nativeInstruction(packet.id, instruction))
            .catch(() => failed(view));
        } catch {
          failed(view);
        }
      }}
    />
  );
}
