import type { ReactNode } from "react";

/**
 * One setup screen: a short progress line, a title that names the step, one
 * sentence, the step's own content, and a footer with the moves — Back on the
 * left, Skip and the step's one action on the right. Every setup screen,
 * including the ones shown while this computer is still starting, uses it, so
 * nothing jumps when one becomes the next.
 */
export function SetupFrame({
  children,
  description,
  footer,
  progress,
  stepKey,
  title,
}: {
  readonly children?: ReactNode;
  readonly description?: ReactNode;
  readonly footer?: ReactNode;
  /** Which step of how many; omitted while there are no steps yet. */
  readonly progress?: { readonly count: number; readonly index: number } | null;
  /** Changes when the step does, so its content enters fresh. */
  readonly stepKey?: string;
  readonly title: ReactNode;
}) {
  return (
    <main className="setup-frame">
      <div className="setup-frame__body">
        <div className="setup-frame__column" key={stepKey}>
          <SetupProgress progress={progress ?? null} />
          <header className="setup-frame__head">
            <h1 aria-live="polite" className="setup-frame__title">
              {title}
            </h1>
            {description ? <p className="setup-frame__description">{description}</p> : null}
          </header>
          {children}
        </div>
      </div>
      {footer ? <footer className="setup-frame__foot">{footer}</footer> : null}
    </main>
  );
}

function SetupProgress({
  progress,
}: {
  readonly progress: { readonly count: number; readonly index: number } | null;
}) {
  const count = progress?.count ?? 3;
  return (
    <div
      aria-hidden={progress === null}
      aria-label={progress ? `Step ${progress.index + 1} of ${progress.count}` : undefined}
      className="setup-progress"
      role={progress ? "img" : undefined}
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          className={
            progress && index <= progress.index
              ? "setup-progress__segment setup-progress__segment--on"
              : "setup-progress__segment"
          }
          key={index}
        />
      ))}
    </div>
  );
}

/** Back on the left; Skip and the step's action on the right. */
export function SetupFooter({
  action,
  onBack,
  onSkip,
  skipLabel = "Skip",
}: {
  readonly action: ReactNode;
  readonly onBack?: (() => void) | undefined;
  readonly onSkip?: (() => void) | undefined;
  readonly skipLabel?: string;
}) {
  return (
    <>
      {onBack ? (
        <button className="btn btn--ghost" onClick={onBack} type="button">
          Back
        </button>
      ) : null}
      <span className="setup-frame__spacer" />
      {onSkip ? (
        <button className="btn btn--ghost" onClick={onSkip} type="button">
          {skipLabel}
        </button>
      ) : null}
      {action}
    </>
  );
}
