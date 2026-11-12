import type { ReactNode } from "react";

/** What a first ask can be, to fill the draft (never to send it). */
export const firstRunSuggestions = [
  "Find a flight to Kyoto in mid-March under $1,200 and hold the best two options",
  "Clean up my Downloads folder: sort by type, bin installers older than a month",
  "Read my last 20 emails from school and list every date I need to remember",
  "Set up a small website for my photos in a new folder",
] as const;

/**
 * Home: what should your agent do, and the composer that starts it. Tasks are
 * in the sidebar until Done.
 */
export function TasksHome({
  agentHome,
  composer,
  firstRun,
  header,
  needsAccount = false,
  onConnectAccount,
  onSuggestion,
}: {
  /** Agent home's path on this computer, where every task works; null until the Host says. */
  readonly agentHome: string | null;
  readonly composer: ReactNode;
  /** No task yet: a line about where the agent works, and a few asks to start from. */
  readonly firstRun: boolean;
  readonly header?: ReactNode;
  /** No AI account is connected yet. */
  readonly needsAccount?: boolean;
  readonly onConnectAccount?: (() => void) | undefined;
  readonly onSuggestion: (text: string) => void;
}) {
  return (
    <div className={firstRun ? "thread tasks-home tasks-home--first" : "thread tasks-home"}>
      {header}
      <div className="tasks-home__scroll">
        <div className="tasks-home__inner">
          <div className="tasks-home__hero">
            <h1 className="hero__title">What should your agent do?</h1>
            {firstRun ? (
              <p className="hero__subtitle">
                {agentHome === null
                  ? "Your agent works on this computer."
                  : `Your agent works on this computer, in ${agentHome}.`}
                {needsAccount ? (
                  <>
                    {" "}
                    <button className="tasks-home__link" onClick={onConnectAccount} type="button">
                      Connect an AI account
                    </button>{" "}
                    to start.
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          {composer}
          {firstRun ? (
            <div className="hero__suggestions">
              {firstRunSuggestions.map((text) => (
                <button
                  className="hero__suggestion"
                  key={text}
                  onClick={() => onSuggestion(text)}
                  type="button"
                >
                  {text}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
