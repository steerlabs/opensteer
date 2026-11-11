import {
  passwordSaveDismissAction,
  passwordSaveMask,
  passwordSavePasswordLabel,
  passwordSavePrompt,
  passwordSaveResultMessage,
  passwordSaveUsernameLabel,
  type BrowserEditingState,
  type BrowserEditingTarget,
} from "@opensteer/client/host";
import { useEffect, useId, useSyncExternalStore } from "react";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import { Icon } from "../icon.js";
import { useNativeBrowserOverlay } from "../native-browser-overlays.js";
import { useToast } from "../toast.js";
import "./password-save-bubble.css";

/**
 * Asks to keep the login this viewer just signed in with, under the address
 * bar. The password itself never reaches here. Over a native page it holds
 * an overlay token, as menus do, so the page never covers it.
 */
export function PasswordSaveBubble({ target }: { readonly target: BrowserEditingTarget | null }) {
  const state = useSyncExternalStore<BrowserEditingState | null>(
    target?.subscribe ?? noSubscription,
    target?.get ?? noState,
    noState,
  );
  const save = state?.passwordSave ?? null;
  const toast = useToast();
  const result = save?.result ?? null;
  useEffect(() => {
    if (!result || !target) return;
    const said = passwordSaveResultMessage(result);
    if (said) (said.ok ? toast.success : toast.error)(said.message);
    target.clearPasswordSave();
  }, [result, target, toast]);
  const open = !!save && !result;
  const ready = useNativeBrowserOverlay(open);
  const titleId = useId();
  const answer = (keep: boolean) => target?.answerPasswordSave(keep);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!open || !ready) return null;
  const prompt = passwordSavePrompt(save.offer.offer);
  const setup = save.offer.offer.kind === "setup";
  return (
    <div aria-labelledby={titleId} className="password-save" role="dialog">
      <div className="password-save__head">
        <span aria-hidden className="password-save__glyph">
          <Icon name="key" />
        </span>
        <div className="password-save__copy">
          <p className="password-save__title" id={titleId}>
            {prompt.title}
          </p>
          <p className="password-save__detail">{prompt.detail}</p>
        </div>
      </div>
      {prompt.username ? (
        <dl className="password-save__fields">
          <dt>{passwordSaveUsernameLabel}</dt>
          <dd>{prompt.username}</dd>
          <dt>{passwordSavePasswordLabel}</dt>
          <dd aria-label="Hidden" className="password-save__mask">
            {passwordSaveMask}
          </dd>
        </dl>
      ) : null}
      <div className="password-save__actions">
        <button
          className="btn btn--small btn--ghost"
          disabled={save.pending}
          onClick={() => answer(false)}
          type="button"
        >
          {passwordSaveDismissAction}
        </button>
        <button
          className="btn btn--small btn--primary"
          disabled={save.pending}
          onClick={() => {
            if (setup)
              void desktopBridge()
                ?.passwordsOpen()
                .catch(() => undefined);
            answer(!setup);
          }}
          type="button"
        >
          {prompt.action}
        </button>
      </div>
    </div>
  );
}

function noSubscription(): () => void {
  return () => undefined;
}
function noState(): null {
  return null;
}
