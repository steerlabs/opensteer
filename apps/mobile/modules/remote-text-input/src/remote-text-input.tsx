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
          const instruction =
            packet.contextId !== undefined &&
            packet.contextId !== (context?.contextId ?? null) &&
            !["compositionend", "keyup", "blur"].includes(packet.event.type)
              ? { preventDefault: true }
              : onEvent(packet.event);
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
