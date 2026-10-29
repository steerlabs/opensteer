import type { ReactNode } from "react";
import { BrandMark } from "./brand.js";
import { Icon } from "./icon.js";

/**
 * The card behind every screen that runs before the shell exists: first run,
 * sign-in, a Workspace invitation, the packaged app's setup steps, and the
 * screens that explain why none of it could start.
 *
 * One scaffold, four slots — the eyebrow naming the moment, the title naming
 * the place or the step, one line of orientation, and the content that asks for
 * something. `footnote` closes the card with the quietest line on it.
 *
 * `bare` drops the card's own surface. A browser tab gives the card nothing to
 * sit on, so it draws its own frame and holds a narrow measure; the packaged
 * app's window is already that surface, and its screens carry lists, progress
 * and identity tables that bring their own frames and want the wider measure.
 */
export function OnboardingCard({
  bare = false,
  children,
  description,
  eyebrow,
  footnote,
  live = false,
  title,
  titleId,
}: {
  readonly bare?: boolean;
  readonly children?: ReactNode;
  readonly description?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly footnote?: ReactNode;
  /**
   * A title that changes as a step advances announces itself and can be taken
   * focus, so the reader hears the progress rather than watching for it.
   */
  readonly live?: boolean;
  readonly title?: ReactNode;
  readonly titleId?: string;
}) {
  const head = eyebrow ?? title ?? description;
  return (
    <main className={bare ? "onboarding onboarding--bare" : "onboarding"}>
      <section aria-labelledby={titleId} className="onboarding__card">
        <div className="onboarding__brand">
          <BrandMark large />
        </div>
        {head ? (
          <div className="onboarding__head">
            {eyebrow ? <p className="eyebrow eyebrow--bright">{eyebrow}</p> : null}
            {title ? (
              <h1
                aria-atomic={live ? "true" : undefined}
                aria-live={live ? "polite" : undefined}
                className="onboarding__title"
                id={titleId}
                tabIndex={live ? -1 : undefined}
              >
                {title}
              </h1>
            ) : null}
            {description ? <p className="onboarding__body">{description}</p> : null}
          </div>
        ) : null}
        {children}
        {footnote ? <p className="onboarding__footnote">{footnote}</p> : null}
      </section>
    </main>
  );
}

/**
 * The one way a pre-shell screen reports a failure: an assertive live region so
 * a reader who has just submitted something hears what went wrong, next to the
 * control that produced it rather than replacing it.
 */
export function ErrorNotice({ message }: { readonly message?: string | null }) {
  if (!message) return null;
  return (
    <p aria-live="assertive" className="notice notice--error" role="alert">
      <Icon name="alert-circle" />
      <span>{message}</span>
    </p>
  );
}

/**
 * The screen for "this could not start". Three moments reach it — the app's own
 * bootstrap failing before React has anything to render, the packaged app
 * failing to open a deployment, and a setup link that could not be redeemed —
 * and each one supplies only what it knows: the sentence a reader can act on,
 * the technical detail underneath it, and a retry when retrying is honest.
 */
export function StartupFailure({
  bare = false,
  children,
  description,
  detail = null,
  eyebrow = "Opensteer",
  footnote,
  onRetry,
  retryLabel = "Try again",
  title = "Opensteer couldn’t start",
}: {
  readonly bare?: boolean;
  /** Anything the failure can show below the detail — a development trace. */
  readonly children?: ReactNode;
  readonly description?: ReactNode;
  /** The failure's own words, shown as the error notice. */
  readonly detail?: string | null;
  readonly eyebrow?: ReactNode;
  readonly footnote?: ReactNode;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly title?: ReactNode;
}) {
  return (
    <OnboardingCard
      bare={bare}
      description={description}
      eyebrow={eyebrow}
      footnote={footnote}
      title={title}
      titleId="startup-failure-heading"
    >
      <ErrorNotice message={detail} />
      {children}
      {onRetry ? (
        <div className="onboarding__actions">
          <button className="btn btn--primary onboarding__primary" onClick={onRetry} type="button">
            {retryLabel}
            <Icon name="reload" />
          </button>
        </div>
      ) : null}
    </OnboardingCard>
  );
}
