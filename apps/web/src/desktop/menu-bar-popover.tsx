import { useEffect, useState } from "react";
import type {
  MenuBarHome,
  MenuBarStatus,
  OpensteerMenuBarBridge,
} from "@opensteer/client/computers";

/** Electron prefixes a main-process refusal with its own words; the person needs only ours. */
export function menuBarFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const own = message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, "");
  return own.trim() || "That didn’t work. Try again.";
}

type Pending = (name: string, run: () => Promise<void>) => Promise<void>;

function usePending(onFailure: (message: string | null) => void): [string | null, Pending] {
  const [pending, setPending] = useState<string | null>(null);
  const run: Pending = async (name, action) => {
    setPending(name);
    onFailure(null);
    try {
      await action();
    } catch (error) {
      onFailure(menuBarFailure(error));
    } finally {
      setPending(null);
    }
  };
  return [pending, run];
}

/**
 * The menu bar item's popover: this Mac's Homes, its switches, what is running,
 * and Stop. Stop and Resume keep their own pending state, so Stop can be
 * pressed at any moment: before status loads and while anything else waits.
 */
export function MenuBarPopover({ bridge }: { readonly bridge: OpensteerMenuBarBridge }) {
  const [status, setStatus] = useState<MenuBarStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stopFailure, setStopFailure] = useState<string | null>(null);
  const [busy, act] = usePending(setFailure);
  const [stopping, stopAct] = usePending(setStopFailure);
  useEffect(() => {
    let current = true;
    void bridge.status().then(
      (value) => {
        if (current) setStatus(value);
      },
      (error: unknown) => {
        if (current) setFailure(menuBarFailure(error));
      },
    );
    const detach = bridge.onStatus(setStatus);
    return () => {
      current = false;
      detach();
    };
  }, [bridge]);
  const stopped = status?.stopped === true;
  const stopProblem = status?.stopProblem ?? stopFailure;
  const stopSection = (
    <section className="menu-bar__section menu-bar__stop">
      <p className={stopped ? "menu-bar__stopped" : "menu-bar__quiet"}>
        {status?.stopLine ?? "Stop cuts agents off this Mac."}
      </p>
      {stopped ? (
        <button
          className="btn btn--primary"
          disabled={stopping === "resume"}
          onClick={() => void stopAct("resume", () => bridge.resume())}
          type="button"
        >
          Resume
        </button>
      ) : (
        <button
          className="btn btn--danger"
          onClick={() => void stopAct("stop", () => bridge.stop())}
          type="button"
        >
          Stop
        </button>
      )}
      {stopProblem ? (
        <p className="menu-bar__failure" role="alert">
          {stopProblem}
        </p>
      ) : null}
    </section>
  );
  if (!status)
    return (
      <main className="menu-bar" aria-busy="true">
        <p className="menu-bar__quiet">{failure ?? "Opensteer"}</p>
        {stopSection}
      </main>
    );
  return (
    <main className="menu-bar">
      {status.homes.length === 0 ? (
        <p className="menu-bar__quiet">This Mac isn’t connected to a Home yet.</p>
      ) : (
        status.homes.map((home) => (
          <MenuBarHomeSection
            busy={busy}
            home={home}
            key={`${home.role}:${home.deploymentId}`}
            onSet={(capability, on, revision) =>
              void act(`switch:${home.deploymentId}:${capability}`, () =>
                bridge.setSwitch({ deploymentId: home.deploymentId, capability, on, revision }),
              )
            }
          />
        ))
      )}
      <section aria-labelledby="menu-bar-now" className="menu-bar__section">
        <h2 className="menu-bar__heading" id="menu-bar-now">
          Now on this Mac
        </h2>
        {status.activity.length ? (
          <ul className="menu-bar__activity">
            {status.activity.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="menu-bar__quiet">Nothing is using this Mac.</p>
        )}
      </section>
      {stopSection}
      {failure ? (
        <p className="menu-bar__failure" role="alert">
          {failure}
        </p>
      ) : null}
      <footer className="menu-bar__footer">
        {status.openAtLogin.available ? (
          <label className="menu-bar__row">
            <span>Open at login</span>
            <input
              checked={status.openAtLogin.on}
              className="switch"
              disabled={busy !== null}
              onChange={(event) => {
                const on = event.currentTarget.checked;
                void act("open-at-login", () => bridge.setOpenAtLogin(on));
              }}
              type="checkbox"
            />
          </label>
        ) : null}
        <button
          className="btn btn--ghost"
          onClick={() => void act("open", () => bridge.openApp())}
          type="button"
        >
          Open Opensteer
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => void act("quit", () => bridge.quitCompletely())}
          type="button"
        >
          Quit Opensteer Completely
        </button>
      </footer>
    </main>
  );
}

function MenuBarHomeSection({
  busy,
  home,
  onSet,
}: {
  readonly busy: string | null;
  readonly home: MenuBarHome;
  readonly onSet: (
    capability: MenuBarHome["switches"][number]["capability"],
    on: boolean,
    revision: number,
  ) => void;
}) {
  const titleId = `menu-bar-home-${home.role}-${home.deploymentId}`;
  const revision = home.revision;
  return (
    <section aria-labelledby={titleId} className="menu-bar__section">
      <p className={`menu-bar__home menu-bar__home--${home.tone}`} id={titleId}>
        {home.line}
      </p>
      {home.switches.length ? (
        <ul className="menu-bar__switches">
          {home.switches.map((item) => {
            const labelId = `${titleId}-${item.capability}`;
            return (
              <li className="menu-bar__row" key={item.capability}>
                <span className="menu-bar__switch-text">
                  <span id={labelId}>{item.label}</span>
                  <span className="menu-bar__detail">{item.detail}</span>
                </span>
                {item.fixed ? (
                  <span className="chip chip--ok">On</span>
                ) : (
                  <input
                    aria-labelledby={labelId}
                    checked={item.on}
                    className="switch"
                    disabled={busy !== null || !home.editable || revision === null}
                    onChange={(event) => {
                      if (revision !== null)
                        onSet(item.capability, event.currentTarget.checked, revision);
                    }}
                    type="checkbox"
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
