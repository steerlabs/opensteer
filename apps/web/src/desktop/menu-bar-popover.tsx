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

/** The menu bar item's popover: this Mac's Homes, its switches, what is running, and Stop. */
export function MenuBarPopover({ bridge }: { readonly bridge: OpensteerMenuBarBridge }) {
  const [status, setStatus] = useState<MenuBarStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
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
  const act = async (name: string, run: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setFailure(null);
    try {
      await run();
    } catch (error) {
      setFailure(menuBarFailure(error));
    } finally {
      setBusy(null);
    }
  };
  if (!status)
    return (
      <main className="menu-bar" aria-busy="true">
        <p className="menu-bar__quiet">{failure ?? "Opensteer"}</p>
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
            onSet={(capability, on) =>
              void act(`switch:${home.deploymentId}:${capability}`, () =>
                bridge.setSwitch({ deploymentId: home.deploymentId, capability, on }),
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
      <section className="menu-bar__section menu-bar__stop">
        <p className={status.stopped ? "menu-bar__stopped" : "menu-bar__quiet"}>
          {status.stopLine}
        </p>
        <button
          className={`btn ${status.stopped ? "btn--primary" : "btn--danger"}`}
          disabled={busy !== null}
          onClick={() =>
            void act(status.stopped ? "resume" : "stop", () =>
              status.stopped ? bridge.resume() : bridge.stop(),
            )
          }
          type="button"
        >
          {status.stopped ? "Resume" : "Stop"}
        </button>
      </section>
      {failure ? (
        <p className="menu-bar__failure" role="alert">
          {failure}
        </p>
      ) : null}
      <footer className="menu-bar__footer">
        <label className="menu-bar__row">
          <span>Open at login</span>
          <input
            checked={status.openAtLogin}
            className="switch"
            disabled={busy !== null}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              void act("open-at-login", () => bridge.setOpenAtLogin(on));
            }}
            type="checkbox"
          />
        </label>
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
  readonly onSet: (capability: MenuBarHome["switches"][number]["capability"], on: boolean) => void;
}) {
  const titleId = `menu-bar-home-${home.role}-${home.deploymentId}`;
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
                    disabled={busy !== null || !home.editable}
                    onChange={(event) => onSet(item.capability, event.currentTarget.checked)}
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
