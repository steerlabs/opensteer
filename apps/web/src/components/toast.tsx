import { observeResize } from "@opensteer/shared/resizeObserver";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { Icon } from "./icon.js";

/**
 * Transient feedback.
 *
 * A Toast says a thing happened and then leaves. Anything a reader has to act
 * on — an error they must resolve, a state they must understand — stays on the
 * page as a `.notice` instead, where it can be re-read. Use this for
 * confirmations: saved, copied, verified, installed.
 */
export type ToastTone = "error" | "success";

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
}

export interface ToastApi {
  /** Confirm that something succeeded. Announced politely. */
  readonly success: (message: string) => void;
  /** Report a transient failure. Announced assertively. */
  readonly error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
interface ToastPlacement {
  readonly element: HTMLElement;
  readonly toolbar: boolean;
}
const ToastPlacementContext = createContext<((placement: ToastPlacement | null) => void) | null>(
  null,
);
export const ToastToolbarContext = createContext<RefCallback<HTMLElement> | undefined>(undefined);
export function useToastPlacement() {
  return useContext(ToastPlacementContext);
}
export function useToastToolbar() {
  return useContext(ToastToolbarContext);
}

/** Success leaves quickly; a failure stays long enough to be read twice. */
const dwellMs: Record<ToastTone, number> = { error: 8_000, success: 4_500 };

/**
 * Mounts the toast layer. Nesting is a no-op — the outermost provider owns the
 * layer — so both app roots can mount one without stacking two.
 */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const existing = useContext(ToastContext);
  if (existing) return <>{children}</>;
  return <ToastLayer>{children}</ToastLayer>;
}

function ToastLayer({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const [placement, setPlacement] = useState<ToastPlacement | null>(null);
  const nextId = useRef(0);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone) => {
      const trimmed = message.trim();
      if (trimmed === "") return;
      const id = (nextId.current += 1);
      setToasts((current) => [...current.slice(-2), { id, message: trimmed, tone }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), dwellMs[tone]),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    let frame = 0;
    const position = () => {
      frame = 0;
      const bounds = placement?.element.getBoundingClientRect();
      layer.classList.toggle("toast-layer--toolbar", placement?.toolbar ?? false);
      if (!bounds?.width) {
        layer.style.removeProperty("left");
        layer.style.removeProperty("right");
        layer.style.removeProperty("top");
        layer.style.removeProperty("bottom");
        return;
      }
      layer.style.left = `${bounds.left}px`;
      layer.style.right = `${window.innerWidth - bounds.right}px`;
      layer.style.top = placement?.toolbar ? `${bounds.top}px` : "auto";
      layer.style.bottom = placement?.toolbar
        ? "auto"
        : `${window.innerHeight - bounds.bottom + 24}px`;
      layer.style.setProperty("--toast-row-height", `${bounds.height}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(position);
    };
    position();
    const stopResize = observeResize(placement ? [placement.element] : [], schedule);
    const address = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".browser-address")) return;
      for (const id of timers.current.keys()) dismiss(id);
    };
    document.addEventListener("focusin", address);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      stopResize();
      document.removeEventListener("focusin", address);
      window.removeEventListener("resize", schedule);
    };
  }, [dismiss, placement, toasts.length > 0]);

  const api = useMemo<ToastApi>(
    () => ({
      error: (message: string) => push(message, "error"),
      success: (message: string) => push(message, "success"),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      <ToastPlacementContext.Provider value={setPlacement}>
        {children}
      </ToastPlacementContext.Provider>
      {toasts.length > 0 ? (
        <div className="toast-layer" ref={layerRef}>
          {toasts.map((toast) => (
            <div
              aria-live={toast.tone === "error" ? "assertive" : "polite"}
              className={toast.tone === "error" ? "toast toast--error" : "toast"}
              key={toast.id}
              role={toast.tone === "error" ? "alert" : "status"}
            >
              <Icon name={toast.tone === "error" ? "alert-circle" : "check"} />
              <span className="toast__message">{toast.message}</span>
              <button
                aria-label="Dismiss"
                className="icon-btn toast__dismiss"
                onClick={() => dismiss(toast.id)}
                type="button"
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

/**
 * The toast API. Safe to call outside a provider — feedback simply goes
 * nowhere rather than throwing in a surface that has no layer mounted.
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? noToasts;
}

const noToasts: ToastApi = { error: () => {}, success: () => {} };
