import { useEffect, useState } from "react";
import {
  menuBarWords,
  type MenuBarRow,
  type MenuBarStatus,
  type OpensteerMenuBarBridge,
} from "@opensteer/client/computers";
import { Icon, type IconName } from "../components/icon.js";
import { ProviderLogo } from "../components/provider-brand.js";

/** Electron prefixes a main-process refusal with its own words; the person needs only ours. */
export function menuBarFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const own = message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, "");
  return own.trim() || "That didn’t work. Try again.";
}

/** The local time a Stop happened, as the popover says it. */
export function menuBarStoppedLine(stoppedAt: string | null, locale?: string): string | null {
  if (!stoppedAt) return null;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(stoppedAt),
  );
  return menuBarWords("menubar.stopped", { time });
}

type Run = (name: string, action: () => Promise<void>) => Promise<void>;

function usePending(onFailure: (message: string | null) => void): [ReadonlySet<string>, Run] {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const run: Run = async (name, action) => {
    setPending((current) => new Set(current).add(name));
    onFailure(null);
    try {
      await action();
    } catch (error) {
      onFailure(menuBarFailure(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
    }
  };
  return [pending, run];
}

/**
 * The menu bar item's popover (design §7). Its header, Right now and Stop come
 * from what this Mac holds, so they draw at once; Stop has its own pending
 * state and shows before anything else has loaded.
 */
export function MenuBarPopover({ bridge }: { readonly bridge: OpensteerMenuBarBridge }) {
  const [status, setStatus] = useState<MenuBarStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stopFailure, setStopFailure] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
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
  const phase = status?.stop.phase ?? "running";
  const stopProblem = status?.stop.problem ?? stopFailure;
  const problemLine = stopProblem ? (
    <p className="menu-bar__failure" role="alert">
      {stopProblem}
    </p>
  ) : null;
  const stopEverything = (
    <button
      className="menu-bar__stop-all"
      disabled={stopping.has("stop")}
      onClick={() => void stopAct("stop", () => bridge.stop())}
      type="button"
    >
      {menuBarWords("menubar.stopAll")}
    </button>
  );
  // Stopped is said only once everything is confirmed ended. While a Stop is
  // under way nothing else is offered; one that could not be confirmed says so
  // and offers Stop everything again, never Resume in its place. It is the
  // popover's only control over what agents do: a row opens its task instead.
  const stopSection = (
    <section className="menu-bar__section menu-bar__stop" aria-live="polite">
      {phase === "running" ? (
        <>
          {stopEverything}
          {status?.stop.offline ? <p className="menu-bar__quiet">{status.stop.offline}</p> : null}
        </>
      ) : phase === "stopping" ? (
        <p className="menu-bar__stopped">{menuBarWords("menubar.stopping")}</p>
      ) : phase === "failed" ? (
        <>
          <p className="menu-bar__stopped">{menuBarWords("menubar.stop.unconfirmed")}</p>
          {problemLine}
          {stopEverything}
        </>
      ) : (
        <>
          {status?.stop.stoppedAt ? (
            <p className="menu-bar__stopped">{menuBarStoppedLine(status.stop.stoppedAt)}</p>
          ) : null}
          <p className="menu-bar__quiet">{menuBarWords("menubar.stopped.detail")}</p>
          {status?.stop.confirmed ? (
            <p className="menu-bar__quiet">{status.stop.confirmed}</p>
          ) : null}
          <button
            className="btn btn--primary menu-bar__resume"
            disabled={stopping.has("resume")}
            onClick={() => void stopAct("resume", () => bridge.resume())}
            type="button"
          >
            {menuBarWords("menubar.resume")}
          </button>
        </>
      )}
      {phase === "failed" ? null : problemLine}
    </section>
  );
  return (
    <main className="menu-bar" aria-busy={status ? undefined : true}>
      <header className="menu-bar__header" aria-live="polite">
        <h1 className="menu-bar__title">{status?.title ?? menuBarWords("menubar.title")}</h1>
        {status?.homes.map((home) => (
          <div className="menu-bar__home" key={home.deploymentId}>
            <p className="menu-bar__home-name">{home.line}</p>
            <p className={`menu-bar__home-status menu-bar__home-status--${home.tone}`}>
              {home.status}
            </p>
          </div>
        ))}
        {status?.moreHomes ? <p className="menu-bar__quiet">{status.moreHomes}</p> : null}
        {status?.noHome ? <p className="menu-bar__quiet">{status.noHome}</p> : null}
      </header>
      {status?.needsYou ? (
        <button
          className="menu-bar__needs-you"
          onClick={() => {
            const target = status.needsYou;
            if (target) void act("needs-you", () => bridge.openNeedsYou(target.deploymentId));
          }}
          type="button"
        >
          {status.needsYou.line}
        </button>
      ) : null}
      {status?.rightNow.length ? (
        <section aria-labelledby="menu-bar-right-now" className="menu-bar__section">
          <h2 className="menu-bar__heading" id="menu-bar-right-now">
            {menuBarWords("menubar.rightNow")}
          </h2>
          <ul className="menu-bar__rows menu-bar__activity">
            {status.rightNow.map((row) => (
              <RightNowRow
                key={row.id}
                row={row}
                onOpen={() =>
                  void act(`row:${row.id}`, () => {
                    // Until desktop main can open one task, the row opens the app.
                    const target = row.opens;
                    return target && bridge.openRow ? bridge.openRow(target) : bridge.openApp();
                  })
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
      {status && status.homes.length ? (
        <section aria-labelledby="menu-bar-this-mac" className="menu-bar__section">
          <h2 className="menu-bar__heading" id="menu-bar-this-mac">
            {menuBarWords("menubar.thisMac")}
          </h2>
          {status.thisMac ? (
            <ThisMacSwitches
              busy={busy.size > 0}
              thisMac={status.thisMac}
              onSet={(capability, on, revision) => {
                const thisMac = status.thisMac;
                if (thisMac)
                  void act(`switch:${capability}`, () =>
                    bridge.setSwitch({
                      deploymentId: thisMac.deploymentId,
                      machineId: thisMac.machineId,
                      capability,
                      on,
                      revision,
                    }),
                  );
              }}
            />
          ) : null}
          {status.thisMacNote ? <p className="menu-bar__quiet">{status.thisMacNote}</p> : null}
        </section>
      ) : null}
      {stopSection}
      {failure ? (
        <p className="menu-bar__failure" role="alert">
          {failure}
        </p>
      ) : null}
      <footer className="menu-bar__footer">
        <button
          className="btn btn--ghost"
          onClick={() => void act("open", () => bridge.openApp())}
          type="button"
        >
          {menuBarWords("menubar.open")}
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => void act("settings", () => bridge.openSettings())}
          type="button"
        >
          {menuBarWords("menubar.settings")}
        </button>
        <button
          aria-expanded={moreOpen}
          aria-label={menuBarWords("menubar.more")}
          className="btn btn--ghost menu-bar__more"
          onClick={() => setMoreOpen((open) => !open)}
          type="button"
        >
          •••
        </button>
      </footer>
      {moreOpen ? (
        <div className="menu-bar__menu" role="menu">
          {status?.openAtLogin.available ? (
            <label
              className="menu-bar__row"
              role="menuitemcheckbox"
              aria-checked={status.openAtLogin.on}
            >
              <span>{menuBarWords("menubar.openAtLogin")}</span>
              <input
                checked={status.openAtLogin.on}
                className="switch"
                disabled={busy.has("open-at-login")}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  void act("open-at-login", () => bridge.setOpenAtLogin(on));
                }}
                type="checkbox"
              />
            </label>
          ) : null}
          <button
            className="btn btn--ghost menu-bar__quit"
            onClick={() => void act("quit", () => bridge.quitCompletely())}
            role="menuitem"
            type="button"
          >
            {menuBarWords("menubar.quit")}
          </button>
        </div>
      ) : null}
    </main>
  );
}

const kindIcon = {
  browser: "globe",
  apps: "app",
  files: "terminal",
  task: "sparkles",
} as const satisfies Record<MenuBarRow["kind"], IconName>;

/**
 * Who is using what, to glance at: the row opens its task in the app, where
 * that task's own Stop is. It never stops anything itself.
 */
function RightNowRow({ row, onOpen }: { readonly row: MenuBarRow; readonly onOpen: () => void }) {
  return (
    <li>
      <button className="menu-bar__activity-row" onClick={onOpen} type="button">
        <span aria-hidden="true" className="menu-bar__mark" data-kind={row.kind}>
          {row.actor.providerId ? (
            <ProviderLogo providerId={row.actor.providerId} />
          ) : (
            <Icon name={kindIcon[row.kind]} />
          )}
        </span>
        <span className="menu-bar__row-text">
          <span
            className={`menu-bar__row-title${row.actor.verified ? " menu-bar__row-title--verified" : ""}`}
          >
            {row.actor.verified ? (
              <Icon className="menu-bar__verified" name="check-circle" />
            ) : null}
            <span className="menu-bar__row-name">{row.actor.label}</span>
          </span>
          <span className="menu-bar__detail menu-bar__row-using">{row.using}</span>
        </span>
        <Icon className="menu-bar__row-open" name="chevron-right" />
      </button>
    </li>
  );
}

function ThisMacSwitches({
  thisMac,
  busy,
  onSet,
}: {
  readonly thisMac: NonNullable<MenuBarStatus["thisMac"]>;
  readonly busy: boolean;
  readonly onSet: (
    capability: NonNullable<MenuBarStatus["thisMac"]>["switches"][number]["capability"],
    on: boolean,
    revision: number,
  ) => void;
}) {
  const revision = thisMac.revision;
  return (
    <ul className="menu-bar__rows">
      {thisMac.switches.map((item) => {
        const labelId = `menu-bar-switch-${item.capability}`;
        return (
          <li className="menu-bar__row" key={item.capability}>
            <span className="menu-bar__row-text">
              <span id={labelId}>{item.label}</span>
              <span className="menu-bar__detail">{item.detail}</span>
            </span>
            {item.fixed ? (
              <span className="chip chip--ok">{menuBarWords("menubar.switch.on")}</span>
            ) : (
              <input
                aria-labelledby={labelId}
                checked={item.on}
                className="switch"
                disabled={busy || !thisMac.editable || revision === null}
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
  );
}
