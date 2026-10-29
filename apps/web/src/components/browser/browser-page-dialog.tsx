import { useWindowInForeground } from "../../ui-utils.js";
import { NativeBrowserOverlay } from "../native-browser-overlays.js";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { browserPromptTextMaxLength, type BrowserDialog } from "@opensteer/protocol";

/**
 * A page's alert, confirm, prompt or leave question. As in a browser it holds
 * only its page: it sits over that page's picture, while the tabs, the other
 * pages and the rest of the app stay usable. Each one is answered once.
 */
export function BrowserPageDialog(props: BrowserPageDialogProps) {
  return (
    <NativeBrowserOverlay>
      <PageDialogSheet {...props} />
    </NativeBrowserOverlay>
  );
}
interface BrowserPageDialogProps {
  dialog: BrowserDialog;
  live: boolean;
  onAnswer: (accept: boolean, promptText?: string) => void;
  site: string | null;
}
function PageDialogSheet({ dialog, live, onAnswer, site }: BrowserPageDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const foreground = useWindowInForeground();
  const [answered, setAnswered] = useState(false);
  const [text, setText] = useState("");
  const leaving = dialog.type === "beforeunload";
  const disabled = answered || !live;

  // An answer lost with the connection leaves the dialog open; once the view
  // is back, it can be answered again.
  useEffect(() => {
    if (!live) setAnswered(false);
  }, [live]);

  useLayoutEffect(() => {
    const form = formRef.current;
    const focused = document.activeElement;
    // A dialog the person raised from the page takes the keyboard; one that
    // opens while they work elsewhere in the app leaves their focus there.
    const fromPage =
      !focused || focused === document.body || form?.closest(".browser-view")?.contains(focused);
    if (form && fromPage && foreground) {
      form.querySelector<HTMLElement>("input, [type='submit']")?.focus({ preventScroll: true });
    }
  }, [foreground]);

  const answer = (accept: boolean) => {
    if (disabled) return;
    setAnswered(true);
    onAnswer(accept, accept && dialog.type === "prompt" ? text : undefined);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    answer(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    answer(false);
  };

  return (
    <div className="browser-page-dialog">
      <form
        aria-describedby="browser-page-dialog-message"
        aria-labelledby="browser-page-dialog-title"
        className="dialog"
        onKeyDown={onKeyDown}
        onSubmit={submit}
        ref={formRef}
        role="alertdialog"
      >
        <header className="dialog__header">
          <h2 className="dialog__title" id="browser-page-dialog-title">
            {leaving ? "Leave site?" : site ? `${site} says` : "This page says"}
          </h2>
        </header>
        <div className="dialog__body">
          <p className="browser-dialog__message" id="browser-page-dialog-message">
            {leaving ? "Changes you made may not be saved." : dialog.message}
          </p>
          {dialog.type === "prompt" ? (
            <input
              aria-label="Your answer"
              className="text-input"
              disabled={disabled}
              maxLength={browserPromptTextMaxLength}
              onChange={(event) => setText(event.currentTarget.value)}
              value={text}
            />
          ) : null}
        </div>
        <footer className="dialog__footer">
          {dialog.type === "alert" ? null : (
            <button className="btn" disabled={disabled} onClick={() => answer(false)} type="button">
              Cancel
            </button>
          )}
          <button className="btn btn--primary" disabled={disabled} type="submit">
            {leaving ? "Leave" : "OK"}
          </button>
        </footer>
      </form>
    </div>
  );
}
