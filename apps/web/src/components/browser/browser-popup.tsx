import { useNativeBrowserOverlay } from "../native-browser-overlays.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  browserPopupHtmlStep,
  browserPopupTitle,
  browserPopupValueError,
  type BrowserPopupStore,
  type BrowserPopupTarget,
} from "@opensteer/client/host";
import type { BrowserPopupState } from "@opensteer/protocol";

export function BrowserPopup({
  store,
  sessionId,
  surfaceId,
  visible,
}: {
  store: BrowserPopupStore;
  sessionId: string;
  surfaceId: string;
  visible: boolean;
}) {
  const target = useMemo(() => store.target(sessionId, surfaceId), [store, sessionId, surfaceId]);
  const view = useSyncExternalStore(target.subscribe, target.get);
  const overlayReady = useNativeBrowserOverlay(visible && !!view.popup);
  useEffect(() => () => target.release(), [target]);
  useEffect(() => {
    if (!visible) target.release();
  }, [visible, target]);
  if (!visible || !view.negotiated || (!overlayReady && !!view.popup)) return null;
  return (
    <>
      {view.control === "other" || view.control === "changing" || view.notice ? (
        <div className="browser-popup-status" role="status">
          {view.control === "other" ? (
            <button type="button" onClick={() => target.acquire()}>
              Take control
            </button>
          ) : view.control === "changing" ? (
            <span>Control changed. Tap the page to continue.</span>
          ) : null}
          {view.notice}
        </div>
      ) : null}
      {view.popup ? (
        <PopupForm
          key={`${view.popup.ref.streamId}:${view.popup.ref.popupId}:${view.popup.ref.revision}`}
          target={target}
          state={view.popup.state}
        />
      ) : null}
    </>
  );
}
function PopupForm({ target, state }: { target: BrowserPopupTarget; state: BrowserPopupState }) {
  const view = useSyncExternalStore(target.subscribe, target.get);
  const popup = view.popup!;
  const [ids, setIds] = useState(() =>
    state.items.filter((i) => i.selected && i.enabled && i.kind === "option").map((i) => i.id),
  );
  const [value, setValue] = useState("value" in state ? state.value : "");
  const [error, setError] = useState<string | null>(null);
  const title = browserPopupTitle(state);
  if (state.kind === "datalist")
    return (
      <div
        className="browser-popup-suggestions"
        role="listbox"
        aria-label="Suggestions"
        dir={state.rtl ? "rtl" : "ltr"}
      >
        {state.items.map((i) => (
          <button
            type="button"
            role="option"
            aria-selected={view.highlighted === i.id}
            disabled={!i.enabled || view.pending}
            key={i.id}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => target.answer(popup.ref, { itemIds: [i.id] })}
            dir={i.directionOverride ? (i.rtl ? "rtl" : "ltr") : "auto"}
          >
            {i.label}
            {i.secondaryLabel ? <small>{i.secondaryLabel}</small> : null}
          </button>
        ))}
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => target.cancel()}
        >
          Dismiss suggestions
        </button>
      </div>
    );
  const submit = () => {
    if (state.kind === "select") {
      if (!target.answer(popup.ref, { itemIds: ids })) setError("Choose an enabled option.");
      return;
    }
    const invalid = browserPopupValueError(state, value);
    // The native parser accepts CSS colors this viewer may not yet understand.
    if (invalid) {
      setError(invalid);
      return;
    }
    target.answer(popup.ref, { value });
  };
  const option = (i: BrowserPopupState["items"][number]) => (
    <option
      key={i.id}
      value={i.id}
      disabled={!i.enabled || i.kind === "separator"}
      dir={i.directionOverride ? (i.rtl ? "rtl" : "ltr") : "auto"}
    >
      {i.kind === "separator" ? "────────" : i.label}
    </option>
  );
  return (
    <div
      className="browser-popup-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) target.cancel();
      }}
    >
      <form
        className="browser-popup"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        dir={state.rtl ? "rtl" : "ltr"}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            target.cancel();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3>{title}</h3>
        {state.kind === "select" ? (
          <select
            autoFocus
            aria-label={title}
            multiple={state.multiple}
            size={Math.min(12, Math.max(2, state.items.length))}
            value={state.multiple ? ids : (ids[0] ?? "")}
            disabled={view.pending}
            onChange={(e) => {
              const next = Array.from(e.currentTarget.selectedOptions, (o) => o.value);
              setIds(next);
              if (!state.multiple) target.answer(popup.ref, { itemIds: next });
            }}
          >
            {state.items.map((i) => {
              if (i.kind === "group") {
                return (
                  <optgroup
                    key={i.id}
                    label={i.label}
                    dir={i.directionOverride ? (i.rtl ? "rtl" : "ltr") : "auto"}
                  >
                    {state.items.filter((o) => o.groupId === i.id).map(option)}
                  </optgroup>
                );
              }
              if (i.groupId && state.items.some((g) => g.id === i.groupId)) return null;
              return option(i);
            })}
          </select>
        ) : (
          <>
            {state.kind === "color" ? (
              <PopupColorControl
                state={state}
                value={value}
                disabled={view.pending}
                onChange={setValue}
              />
            ) : (
              <input
                aria-label={title}
                type={state.kind}
                disabled={view.pending}
                value={value}
                step={browserPopupHtmlStep(state)}
                onChange={(e) => setValue(e.currentTarget.value)}
              />
            )}
            <label>
              Exact{" "}
              {state.kind === "color"
                ? `CSS color (${state.colorSpace}${state.alpha ? ", alpha allowed" : ""})`
                : "value"}
              <input
                autoFocus
                type="text"
                value={value}
                disabled={view.pending}
                onChange={(e) => {
                  setValue(e.currentTarget.value);
                  setError(null);
                }}
              />
            </label>
            {state.items
              .filter((i) => i.kind === "suggestion")
              .map((i) => (
                <button
                  key={i.id}
                  type="button"
                  disabled={!i.enabled || view.pending}
                  onClick={() => target.answer(popup.ref, { itemIds: [i.id] })}
                >
                  {i.label}
                  {i.secondaryLabel ? <small>{i.secondaryLabel}</small> : null}
                </button>
              ))}
          </>
        )}
        {error ? <div role="alert">{error}</div> : null}
        <div className="browser-popup-actions">
          <button type="button" onClick={() => target.cancel()}>
            Cancel
          </button>
          <button type="submit" disabled={view.pending}>
            Done
          </button>
        </div>
      </form>
    </div>
  );
}

function PopupColorControl({
  state,
  value,
  disabled,
  onChange,
}: {
  state: Extract<BrowserPopupState, { kind: "color" }>;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [exactOnly, setExactOnly] = useState(false);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const extended =
      state.colorSpace === "display-p3" || state.alpha || !/^#[\da-f]{6}$/i.test(value);
    const supported =
      !extended || ("colorSpace" in element && (!state.alpha || "alpha" in element));
    const valid = typeof CSS !== "undefined" && CSS.supports("color", value);
    element.hidden = !supported || !valid;
    setExactOnly(!supported || !valid);
    if (!supported || !valid) return;
    element.setAttribute(
      "colorspace",
      state.colorSpace === "display-p3" ? "display-p3" : "limited-srgb",
    );
    if (state.alpha) element.setAttribute("alpha", "");
    else element.removeAttribute("alpha");
    element.value = value;
  }, [value, state.alpha, state.colorSpace]);
  return (
    <>
      <input
        ref={input}
        aria-label="Color"
        type="color"
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      {exactOnly ? <p>Use the exact CSS value for this color.</p> : null}
    </>
  );
}
