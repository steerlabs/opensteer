import { useEffect, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "../icon.js";

/** Whose move it is: Opensteer's, the person's, or nobody's because setup ended. */
export type SetupTone = "working" | "you" | "done" | "problem";

export interface SetupStageProps {
  readonly actions?: ReactNode;
  /** Context below the actions, such as what setup needs, so the answer stays near the ask. */
  readonly after?: ReactNode;
  /** Shown between the words and the actions: a list to pick from, or how-to. */
  readonly body?: ReactNode;
  /** Where the person acts, said above the title while setup waits on them. */
  readonly cue?: string;
  readonly detail?: ReactNode;
  readonly icon?: IconName;
  /** Which of setup's stages it is in, while it runs. */
  readonly step?: number | undefined;
  readonly title: string;
  readonly tone: SetupTone;
  /**
   * What setup is watching for while it waits on the person; it moves on by
   * itself once it sees it, so there is nothing to press.
   */
  readonly waiting?: string | undefined;
}

/**
 * The one thing happening now in a phone's setup. Whose move it is reads from
 * the glyph's shape and the words, never from color or motion alone: Opensteer
 * working is a spinner with nothing to press, and the person's turn names
 * where to act or offers the buttons that answer it. It stays mounted from
 * phase to phase so its words are one live region a screen reader follows.
 */
export function SetupStage({
  actions,
  after,
  body,
  cue,
  detail,
  icon,
  step,
  steps,
  title,
  tone,
  waiting,
}: SetupStageProps & { readonly steps: number }) {
  const ref = useRef<HTMLElement | null>(null);
  // The button just pressed can leave with the phase it belonged to; focus
  // stays in the dialog so Escape and Tab still reach it.
  useEffect(() => {
    if (document.activeElement === document.body) ref.current?.focus();
  }, [title]);
  const glyph =
    icon ?? (tone === "done" ? "check-circle" : tone === "problem" ? "alert-circle" : "phone");
  return (
    <section className={`phone-setup phone-setup--${tone}`} ref={ref} tabIndex={-1}>
      <span aria-hidden="true" className="phone-setup__glyph">
        {tone === "working" ? <span className="spinner" /> : <Icon name={glyph} />}
      </span>
      <div className="phone-setup__words" role="status">
        {cue ? <p className="phone-setup__cue">{cue}</p> : null}
        <h3 className="phone-setup__title">{title}</h3>
        {detail ? <p className="phone-setup__detail">{detail}</p> : null}
        {waiting ? (
          <p className="phone-setup__waiting">
            <span aria-hidden="true" className="phone-setup__pulse" />
            {waiting}
          </p>
        ) : null}
      </div>
      {body}
      {actions ? <div className="phone-setup__actions">{actions}</div> : null}
      {after}
      {step === undefined ? null : (
        <ol aria-label={`Step ${step + 1} of ${steps}`} className="phone-setup__rail" role="img">
          {Array.from({ length: steps }, (_, index) => (
            <li
              className={index < step ? "is-done" : index === step ? "is-current" : undefined}
              key={index}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
