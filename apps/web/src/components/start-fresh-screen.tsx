import { BrandMark } from "./brand.js";
import { Icon, type IconName } from "./icon.js";

/**
 * The desktop app found data an earlier Opensteer left, which this one can't
 * open. Nothing is deleted: the old data is renamed aside, the agent's home
 * folder is never touched, and this computer starts with a new identity.
 */
export function StartFreshScreen({
  agentHome = "~/Opensteer",
  error = null,
  onQuit,
  onReveal,
  onStartFresh,
  setAsidePath,
  working = false,
}: {
  readonly agentHome?: string;
  /** Why the last try failed; the old data is still where it was. */
  readonly error?: string | null;
  readonly onQuit: () => void;
  /** Shows the folder the old data will be moved into. */
  readonly onReveal?: (() => void) | undefined;
  readonly onStartFresh: () => void;
  /** Where the earlier data goes, e.g. "Application Support/Opensteer/Earlier 2026-11-11". */
  readonly setAsidePath: string;
  readonly working?: boolean;
}) {
  return (
    <main className="start-fresh">
      <div className="start-fresh__card">
        <BrandMark large />
        <p className="eyebrow eyebrow--accent">A new Opensteer</p>
        <h1 className="start-fresh__title">Your data is from an earlier Opensteer</h1>
        <p className="start-fresh__lead">
          This version is built around your agent and your tasks, by folder. It can’t open what the
          earlier one kept on this computer, so it starts with a clean slate. Nothing is deleted.
        </p>
        <ul className="start-fresh__facts">
          <Fact icon="history" title="Set aside, not deleted">
            Your earlier tasks and settings, the browser profiles they used, and their saved sign-in
            keys move to <code>{setAsidePath}</code>
            {onReveal ? (
              <>
                {" "}
                <button className="start-fresh__link" onClick={onReveal} type="button">
                  Show in Finder
                </button>
              </>
            ) : null}
            .
          </Fact>
          <Fact icon="home" title="Untouched">
            <code>{agentHome}</code>, your agent’s home folder, with its memory and AGENTS.md.
          </Fact>
          <Fact icon="phone" title="Pair your devices again">
            This computer gets a new identity, so your phone and other devices connect to it again.
            The old entry in your Opensteer Account can be removed.
          </Fact>
        </ul>
        {error ? (
          <p className="notice notice--error" role="alert">
            <Icon name="alert-circle" />
            <span>{error} Your earlier data is still where it was.</span>
          </p>
        ) : null}
        <div className="start-fresh__actions">
          <button className="btn btn--ghost" disabled={working} onClick={onQuit} type="button">
            Quit Opensteer
          </button>
          <button
            aria-disabled={working}
            className="btn btn--primary"
            onClick={() => {
              if (!working) onStartFresh();
            }}
            type="button"
          >
            {working ? "Starting fresh…" : error ? "Try again" : "Start fresh"}
          </button>
        </div>
      </div>
    </main>
  );
}

function Fact({
  children,
  icon,
  title,
}: {
  readonly children: React.ReactNode;
  readonly icon: IconName;
  readonly title: string;
}) {
  return (
    <li className="start-fresh__fact">
      <span aria-hidden className="start-fresh__icon">
        <Icon name={icon} />
      </span>
      <span>
        <span className="start-fresh__fact-title">{title}</span>
        <span className="start-fresh__fact-body">{children}</span>
      </span>
    </li>
  );
}
