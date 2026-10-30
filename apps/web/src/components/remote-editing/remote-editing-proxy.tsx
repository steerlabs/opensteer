import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  createEditingState,
  reduceEditing,
  resolveEditingBinding,
  type EditingOperation,
  type EditingProxyEvent,
  type EditingProxyState,
  type EditingTargetAbilities,
  type EditingViewerPlatform,
  type EditingClipboardPayloadItem,
} from "@opensteer/client/editing";
import type { ViewerClipboardResult } from "@opensteer/client/host";
import type { EditingContext } from "@opensteer/protocol/editing";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import { ProxyField, type RemoteProxyElement } from "./proxy-field.js";
import { editingProxyAttributes } from "./proxy-attributes.js";
import { ViewerClipboard } from "./viewer-clipboard.js";
import "./remote-editing.css";

export interface RemoteEditingWire {
  send(operation: EditingOperation): Promise<ViewerClipboardResult | undefined>;
  subscribeClipboard?(
    onWritten: (items: readonly EditingClipboardPayloadItem[]) => void,
    onError?: (message: string) => void,
  ): () => void;
}
export interface RemoteEditingProxyHandle {
  cancel(): void;
  focus(touch?: boolean): void;
  pointerDown(): void;
  activate(): void;
  perform(operation: EditingOperation): void;
  pasteFromMenu(): void;
  copyText(text: string): void;
}
export interface RemoteCaretPosition {
  readonly left: number;
  readonly top: number;
  readonly height: number;
}
export function viewerEditingPlatform(): EditingViewerPlatform {
  const platform = navigator.platform;
  if (
    /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
    (platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
    return "ios";
  if (/Mac/u.test(platform)) return "mac";
  if (/Win/u.test(platform)) return "windows";
  if (/CrOS/u.test(navigator.userAgent)) return "chromeos";
  return /Android/u.test(navigator.userAgent) ? "android" : "linux";
}
const snapshot = (element: RemoteProxyElement): EditingProxyState => ({
  value: element.value,
  selectionStart: element.selectionStart ?? element.value.length,
  selectionEnd: element.selectionEnd ?? element.value.length,
});

/** A surface supplies its wire, abilities and mapped caret; native editing stays here. */
export function RemoteEditingProxy({
  abilities,
  caret,
  context,
  enabled,
  label,
  onLeave,
  cancelCompositionOnBlur = false,
  platform,
  ref,
  wire,
}: {
  readonly abilities: EditingTargetAbilities;
  readonly caret: RemoteCaretPosition | null;
  readonly context: EditingContext | null;
  readonly enabled: boolean;
  readonly label: string;
  readonly cancelCompositionOnBlur?: boolean;
  readonly onLeave?: (() => void) | undefined;
  readonly platform?: EditingViewerPlatform;
  readonly ref?: Ref<RemoteEditingProxyHandle>;
  readonly wire: RemoteEditingWire;
}) {
  const element = useRef<RemoteProxyElement | null>(null);
  const lastElement = useRef<RemoteProxyElement | null>(null);
  const restoreFocus = useRef(false);
  const state = useRef(createEditingState(platform ?? viewerEditingPlatform(), abilities));
  const current = useRef({ enabled, context, abilities, wire, onLeave, cancelCompositionOnBlur });
  current.current = { enabled, context, abilities, wire, onLeave, cancelCompositionOnBlur };
  const [preedit, setPreedit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const touchFocus = useRef(false);
  const alive = useRef(true);
  const revision = useRef(0);
  const clipboard = useRef<ViewerClipboard | null>(null);
  if (!clipboard.current) {
    const native = desktopBridge()?.writeViewerClipboard;
    clipboard.current = new ViewerClipboard((message) => {
      if (alive.current) setError(message);
    }, native);
  }
  const failure = useCallback((reason: unknown) => {
    if (alive.current)
      setError(reason instanceof Error ? reason.message : "Remote editing failed.");
  }, []);
  const perform = useCallback(
    (operation: EditingOperation) => {
      if (
        !current.current.enabled &&
        !(operation.kind === "key" && operation.keystroke.action === "up")
      )
        return;
      const arm =
        operation.kind === "copy" || operation.kind === "cut"
          ? clipboard.current!.arm(operation.kind)
          : null;
      setError(null);
      try {
        void current.current.wire.send(operation).then(
          (result) => {
            if (!arm) {
              if (result && !["copied", "cut", "pasted", "empty"].includes(result.outcome))
                failure(new Error(`The remote clipboard operation was ${result.outcome}.`));
              return;
            }
            if (
              result &&
              (result.outcome === "copied" || result.outcome === "cut") &&
              result.items.some((item) => item.bytes.byteLength > 0)
            )
              arm.resolve(result.items);
            else {
              arm.reject();
              if (result && result.outcome !== "empty")
                failure(new Error(`The remote clipboard operation was ${result.outcome}.`));
            }
          },
          (reason) => {
            arm?.reject();
            failure(reason);
          },
        );
      } catch (reason) {
        arm?.reject();
        failure(reason);
      }
    },
    [failure],
  );
  const feed = useCallback(
    (event: EditingProxyEvent, native?: Event) => {
      const step = reduceEditing(state.current, event);
      state.current = step.state;
      if (step.refusal)
        setError(
          step.refusal === "too-large"
            ? "This native edit exceeds the editing size limit."
            : step.refusal === "commands"
              ? "This target does not support that editing command."
              : step.refusal === "range-edits"
                ? "This target cannot verify a text replacement."
                : "This target does not support that clipboard format or operation.",
        );
      const ownRevision = ++revision.current;
      if (step.instruction.preventDefault) native?.preventDefault();
      if (
        event.type === "keydown" &&
        step.operations.some(
          (operation) =>
            operation.kind === "key" &&
            operation.keystroke.action === "down" &&
            (operation.keystroke.key === "Enter" || operation.keystroke.key === " "),
        )
      )
        clipboard.current!.armActivation();
      for (const operation of step.operations) perform(operation);
      setPreedit(
        step.state.composition?.detached ? "" : (step.state.composition?.nativeText ?? ""),
      );
      const set = step.instruction.set;
      if (set) {
        const apply = () => {
          if (
            !alive.current ||
            revision.current !== ownRevision ||
            state.current.composition ||
            !element.current
          )
            return;
          element.current.value = set.value;
          element.current.setSelectionRange(set.selectionStart, set.selectionEnd);
        };
        // Input/composition listeners must return before touching the native text store.
        if (
          [
            "input",
            "beforeinput",
            "compositionstart",
            "compositionupdate",
            "compositionend",
          ].includes(event.type)
        )
          queueMicrotask(apply);
        else apply();
      }
    },
    [perform],
  );
  const focus = useCallback((touch = false) => {
    if (!current.current.enabled || !element.current) return;
    touchFocus.current = touch;
    if (touch && !current.current.context?.field) return;
    element.current.focus({ preventScroll: true });
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      cancel() {
        state.current = { ...state.current, composition: null, compositionTail: "discard" };
        feed({ type: "blur" });
        if (element.current) element.current.value = "";
      },
      focus,
      pointerDown: () => {
        const composing = state.current.composition !== null;
        feed({ type: "pointerdown" });
        if (composing) element.current?.blur();
      },
      activate: () => {
        if (current.current.enabled) clipboard.current!.armActivation();
      },
      perform: (operation) => {
        if (operation.kind === "copy" || operation.kind === "cut") feed({ type: operation.kind });
        else {
          feed({ type: "pointerdown" });
          perform(operation);
        }
      },
      copyText: (text) => {
        const arm = clipboard.current!.arm("copy");
        arm.resolve([{ type: "text/plain", bytes: new TextEncoder().encode(text) }]);
      },
      pasteFromMenu: () => {
        focus();
        const nativePaste = desktopBridge()?.pasteViewerClipboard;
        if (nativePaste) {
          void nativePaste().catch(failure);
          return;
        }
        if (!navigator.clipboard?.read) {
          failure(
            new Error(
              "This browser cannot read the clipboard from a menu. Use the paste keyboard shortcut.",
            ),
          );
          return;
        }
        const scope = current.current.context?.contextId;
        // A custom web menu has no native Paste command; Clipboard.read is gesture-gated.
        void navigator.clipboard
          .read()
          .then(async (items) => {
            const payload: EditingClipboardPayloadItem[] = [];
            for (const item of items)
              for (const type of item.types) {
                const blob = await item.getType(type);
                payload.push({ type, bytes: new Uint8Array(await blob.arrayBuffer()) });
              }
            if (current.current.context?.contextId !== scope || !current.current.enabled)
              throw new Error("The remote field changed before paste completed.");
            feed({ type: "paste", items: payload });
          })
          .catch(failure);
      },
    }),
    [failure, feed, focus, perform],
  );
  useLayoutEffect(() => {
    const composing =
      state.current.composition !== null && state.current.context?.contextId !== context?.contextId;
    const focused = document.activeElement === element.current;
    state.current = { ...state.current, abilities };
    feed({ type: "context", context });
    if (composing) {
      element.current?.blur();
      if (enabled && focused) focus(touchFocus.current);
    }
    if (!enabled) {
      feed({ type: "blur" });
      element.current?.blur();
    } else if (touchFocus.current && context?.field) focus(true);
  }, [abilities, context, enabled, feed, focus]);
  useEffect(() => {
    if (!enabled || !wire.subscribeClipboard) return;
    return wire.subscribeClipboard((items) => {
      void clipboard.current!.written(items).catch(failure);
    }, failure);
  }, [enabled, wire, failure]);
  const assign = useCallback(
    (value: RemoteProxyElement | null) => {
      if (!value && element.current === document.activeElement) restoreFocus.current = true;
      if (value && lastElement.current && value !== lastElement.current) {
        feed({ type: "blur" });
        state.current = reduceEditing(
          createEditingState(state.current.platform, current.current.abilities),
          { type: "context", context: current.current.context },
        ).state;
      }
      element.current = value;
      if (value) lastElement.current = value;
    },
    [feed],
  );
  const sensitive = context?.field?.sensitive ?? false;
  useLayoutEffect(() => {
    const field = element.current;
    if (!field) return;
    const listeners: readonly (readonly [string, EventListener])[] = [
      ...(["keydown", "keyup"] as const).map(
        (type) =>
          [
            type,
            ((event: KeyboardEvent) => {
              if (!current.current.enabled) return;
              if (
                event.key === "F6" &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.shiftKey &&
                current.current.onLeave
              ) {
                event.preventDefault();
                event.stopPropagation();
                if (type === "keydown") current.current.onLeave();
                return;
              }
              event.stopPropagation();
              const keyEvent: Extract<EditingProxyEvent, { type: "keydown" | "keyup" }> = {
                type,
                key: event.key,
                code: event.code,
                alt: event.altKey,
                control: event.ctrlKey,
                meta: event.metaKey,
                shift: event.shiftKey,
                altGraph: event.getModifierState("AltGraph"),
                location:
                  event.location === 1 || event.location === 2 || event.location === 3
                    ? event.location
                    : 0,
                repeat: event.repeat,
                composing: event.isComposing || event.keyCode === 229 || event.key === "Process",
              };
              if (type === "keydown" && desktopBridge()?.writeViewerClipboard) {
                const binding = resolveEditingBinding(keyEvent, state.current.platform);
                if (binding?.kind === "copy" || binding?.kind === "cut") {
                  feed({ type: binding.kind }, event);
                  return;
                }
                const nativePaste = desktopBridge()?.pasteViewerClipboard;
                if (binding?.kind === "paste" && nativePaste) {
                  event.preventDefault();
                  void nativePaste().catch(failure);
                  return;
                }
              }
              feed(keyEvent, event);
            }) as EventListener,
          ] as const,
      ),
      [
        "beforeinput",
        (event) => {
          const input = event as InputEvent;
          feed({ type: "beforeinput", inputType: input.inputType, data: input.data }, event);
        },
      ],
      [
        "input",
        (event) => {
          const input = event as InputEvent;
          feed(
            {
              type: "input",
              inputType: input.inputType,
              composing: input.isComposing,
              proxy: snapshot(field),
            },
            event,
          );
        },
      ],
      [
        "compositionstart",
        (event) => feed({ type: "compositionstart", proxy: snapshot(field) }, event),
      ],
      [
        "compositionupdate",
        (event) =>
          feed(
            {
              type: "compositionupdate",
              data: (event as CompositionEvent).data,
              proxy: snapshot(field),
            },
            event,
          ),
      ],
      [
        "compositionend",
        (event) =>
          feed(
            {
              type: "compositionend",
              data: (event as CompositionEvent).data,
              proxy: snapshot(field),
            },
            event,
          ),
      ],
      ["select", (event) => feed({ type: "selection", proxy: snapshot(field) }, event)],
      [
        "copy",
        (event) => {
          if (current.current.enabled) feed({ type: "copy" }, event);
        },
      ],
      [
        "cut",
        (event) => {
          if (current.current.enabled) feed({ type: "cut" }, event);
        },
      ],
      [
        "paste",
        (event) => {
          if (!current.current.enabled) return;
          const paste = event as ClipboardEvent;
          if (!paste.isTrusted) {
            failure(new Error("Paste requires a trusted local clipboard event."));
            return;
          }
          paste.preventDefault();
          const data = paste.clipboardData;
          if (!data) return;
          const scope = current.current.context?.contextId;
          const items: EditingClipboardPayloadItem[] = [];
          for (const type of ["text/plain", "text/html"])
            if (data.types.includes(type))
              items.push({ type, bytes: new TextEncoder().encode(data.getData(type)) });
          const files = [...data.files];
          if (!files.length) {
            feed({ type: "paste", items }, event);
            return;
          }
          void Promise.all(
            files.map(async (file) => ({
              type: file.type || "application/octet-stream",
              name: file.name,
              bytes: new Uint8Array(await file.arrayBuffer()),
            })),
          )
            .then((files) => {
              if (
                !alive.current ||
                !current.current.enabled ||
                current.current.context?.contextId !== scope
              )
                throw new Error("The remote field changed before paste completed.");
              feed({ type: "paste", items: [...items, ...files] });
            })
            .catch(failure);
        },
      ],
      [
        "focus",
        () => {
          const bridge = desktopBridge();
          if (bridge?.setViewerKeyboardActive)
            void bridge.setViewerKeyboardActive(true).catch(failure);
        },
      ],
      [
        "blur",
        (event) => {
          if (current.current.cancelCompositionOnBlur)
            state.current = { ...state.current, composition: null, compositionTail: "discard" };
          feed({ type: "blur" }, event);
          const bridge = desktopBridge();
          if (bridge?.setViewerKeyboardActive)
            void bridge.setViewerKeyboardActive(false).catch(failure);
        },
      ],
    ];
    for (const [type, listener] of listeners) field.addEventListener(type, listener);
    if (restoreFocus.current) {
      restoreFocus.current = false;
      focus(touchFocus.current);
    }
    return () => {
      for (const [type, listener] of listeners) field.removeEventListener(type, listener);
    };
  }, [feed, failure, sensitive, focus]);
  useEffect(() => {
    alive.current = true;
    return () => {
      feed({ type: "blur" });
      alive.current = false;
      clipboard.current!.dispose();
      const bridge = desktopBridge();
      if (bridge?.setViewerKeyboardActive)
        void bridge.setViewerKeyboardActive(false).catch(failure);
    };
  }, [feed, failure]);
  return (
    <>
      <ProxyField
        sensitive={sensitive}
        aria-label={label}
        {...editingProxyAttributes(abilities, context)}
        className="remote-keyboard-input"
        disabled={!enabled}
        ref={assign}
        style={{
          left: caret?.left ?? 0,
          top: caret?.top ?? 0,
          height: Math.max(1, caret?.height ?? 1),
        }}
        tabIndex={enabled ? 0 : -1}
      />
      {!abilities.composition && preedit ? (
        <span
          className="remote-preedit"
          data-remote-preedit=""
          style={{ left: caret?.left ?? 0, top: (caret?.top ?? 0) + (caret?.height ?? 0) }}
        >
          {sensitive ? "•".repeat([...preedit].length) : preedit}
        </span>
      ) : null}
      {error ? (
        <span className="remote-editing-error" role="status">
          {error}
        </span>
      ) : null}
    </>
  );
}
