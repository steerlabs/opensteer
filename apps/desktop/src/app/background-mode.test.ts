import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { App, MenuItem, MenuItemConstructorOptions, PowerMonitor } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopApplicationMenu } from "./application-menu.js";
import {
  backgroundNoticeFileStore,
  DesktopBackgroundMode,
  dockHideRetryMs,
  quitCompletelyConfirmation,
} from "./background-mode.js";
import type { ActivitySnapshot } from "./desktop-activity.js";
import { DesktopShutdown } from "./desktop-shutdown.js";
import { DesktopQuitRouting, type QuitActions } from "./quit-routing.js";

const { build } = vi.hoisted(() => ({ build: vi.fn((template: unknown) => template) }));
vi.mock("electron", () => ({ Menu: { buildFromTemplate: build } }));

let signals: Map<"SIGINT" | "SIGTERM", ReturnType<typeof process.listeners>>;
const directories: string[] = [];
beforeEach(() => {
  signals = new Map(
    ["SIGINT", "SIGTERM"].map((name) => [name as "SIGINT" | "SIGTERM", process.listeners(name)]),
  );
});
afterEach(async () => {
  for (const [name, existing] of signals)
    for (const listener of process.listeners(name))
      if (!existing.includes(listener)) process.removeListener(name, listener);
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

const nothing: ActivitySnapshot = { known: true, hostsHome: false, deviceHomes: [], lines: [] };

function fixture(work: () => Promise<ActivitySnapshot> = async () => nothing, answer = true) {
  const application = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const power = new EventEmitter();
  const log = vi.fn();
  const shutdown = new DesktopShutdown({
    application: application as unknown as Pick<App, "on" | "exit">,
    power: power as unknown as Pick<PowerMonitor, "on">,
    log,
  });
  const stopped = vi.fn();
  shutdown.add({ component: "personal", step: "stop", order: 40, timeoutMs: 100, stop: stopped });
  const window = { hide: vi.fn() };
  let docked = true;
  let shownAt = -Infinity;
  let clock = 0;
  const dock = {
    // As Electron does: a hide within a second of a show is ignored.
    hide: vi.fn(() => {
      if (clock - shownAt >= 1_000) docked = false;
    }),
    show: vi.fn(() => {
      docked = true;
      shownAt = clock;
    }),
    isVisible: () => docked,
  };
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0))
      if (timer.at <= clock && !timer.cancelled) timer.run();
      else if (!timer.cancelled) timers.push(timer);
  };
  let seen = false;
  const notice = {
    seen: vi.fn(async () => seen),
    markSeen: vi.fn(async () => {
      seen = true;
    }),
    show: vi.fn(),
  };
  const confirm = vi.fn(async (_confirmation: unknown, _signal: AbortSignal) => answer);
  const mode = new DesktopBackgroundMode({
    shutdown,
    window,
    dock,
    notice,
    work,
    confirm,
    log,
    schedule: (run, delayMs) => {
      const timer = { at: clock + delayMs, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const routing = new DesktopQuitRouting({ shutdown, hideWindows: vi.fn(), log, confirm });
  const exited = () =>
    vi.waitFor(() => expect(application.exit).toHaveBeenCalledWith(0), { timeout: 2_000 });
  return {
    advance,
    application,
    confirm,
    dock,
    docked: () => docked,
    exited,
    mode,
    notice,
    power,
    routing,
    shutdown,
    stopped,
    window,
  };
}

/** The production app menu, built as main builds it, and one of its items clicked. */
function menuItem(actions: QuitActions, id: string): MenuItemConstructorOptions {
  createDesktopApplicationMenu({ quit: actions, workspaceContents: () => null });
  const template = build.mock.calls.at(-1)![0] as MenuItemConstructorOptions[];
  const items = template.flatMap((item) =>
    Array.isArray(item.submenu) ? (item.submenu as MenuItemConstructorOptions[]) : [item],
  );
  expect(items.some((item) => item.role === "quit")).toBe(false);
  return items.find((item) => item.id === id)!;
}
const click = (item: MenuItemConstructorOptions) =>
  item.click!({} as MenuItem, undefined, {} as KeyboardEvent);

describe("quit routing through the production app menu", () => {
  it("puts the app away on Cmd+Q and keeps every service running", async () => {
    const { application, dock, mode, notice, routing, shutdown, stopped, window } = fixture();
    routing.attach(mode);
    const quit = menuItem(routing.actions, "quit");
    expect(quit.accelerator).toBe("CommandOrControl+Q");
    click(quit);
    click(quit);
    await vi.waitFor(() => expect(notice.markSeen).toHaveBeenCalled());
    expect(window.hide).toHaveBeenCalledTimes(2);
    expect(dock.hide).toHaveBeenCalled();
    expect(notice.show).toHaveBeenCalledTimes(1);
    expect(shutdown.requested).toBe(false);
    expect(stopped).not.toHaveBeenCalled();
    expect(application.exit).not.toHaveBeenCalled();
  });

  it("is installed at ready, before the menu bar app exists, and never quits then", () => {
    const { routing, shutdown } = fixture();
    const application = new EventEmitter();
    const installed = vi.fn();
    routing.installAtReady(application, installed);
    expect(installed).not.toHaveBeenCalled();
    application.emit("ready");
    expect(installed).toHaveBeenCalledWith(routing.actions);
    click(menuItem(routing.actions, "quit"));
    expect(shutdown.requested).toBe(false);
    expect(routing.quitBeforeStart).toBe(true);
  });

  it("asks about unknown activity when quitting completely during startup", async () => {
    const { routing, shutdown, confirm } = fixture();
    confirm.mockResolvedValue(false);
    click(menuItem(routing.actions, "quit-completely"));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("can’t tell") }),
      expect.any(AbortSignal),
    );
    expect(shutdown.requested).toBe(false);
  });

  it("runs the full ordered shutdown for Quit Opensteer Completely", async () => {
    const { confirm, exited, mode, routing, shutdown, stopped } = fixture();
    routing.attach(mode);
    click(menuItem(routing.actions, "quit-completely"));
    await vi.waitFor(() => expect(shutdown.requested).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
    await exited();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("asks first when this Mac hosts a Home, and stays running when the person declines", async () => {
    const hosting = async () => ({ ...nothing, hostsHome: true });
    const declined = fixture(hosting, false);
    await expect(declined.mode.quitCompletely()).resolves.toBe(false);
    expect(declined.confirm).toHaveBeenCalledWith(
      {
        message: "Quit Opensteer?",
        detail: expect.stringContaining("This Mac is your Home"),
      },
      declined.shutdown.signal,
    );
    expect(declined.shutdown.requested).toBe(false);

    const accepted = fixture(hosting, true);
    await expect(accepted.mode.quitCompletely()).resolves.toBe(true);
    await accepted.exited();
  });

  it("still asks, saying it cannot tell, when what is running here cannot be read", async () => {
    const { confirm, mode } = fixture(async () => {
      throw new Error("Device status unavailable");
    }, false);
    await expect(mode.quitCompletely()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("can’t tell right now whether agents are using this Mac"),
      }),
      expect.anything(),
    );
  });

  it("lets a termination dismiss the open question and shut down", async () => {
    const { confirm, exited, mode, shutdown } = fixture(async () => ({
      ...nothing,
      hostsHome: true,
    }));
    confirm.mockImplementationOnce(
      (_question, signal: AbortSignal) =>
        new Promise<boolean>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    const quitting = mode.quitCompletely();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    process.emit("SIGTERM");
    await expect(quitting).resolves.toBe(true);
    expect(shutdown.requested).toBe(true);
    await exited();
  });

  it("asks nothing when SIGTERM arrives while Quit Completely reads what is running", async () => {
    let finish!: (snapshot: ActivitySnapshot) => void;
    const { confirm, exited, mode, shutdown } = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const quitting = mode.quitCompletely();
    process.emit("SIGTERM");
    finish({ ...nothing, hostsHome: true });
    await expect(quitting).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(shutdown.requested).toBe(true);
    await exited();
  });

  it.each([
    ["logout, restart or power off", (power: EventEmitter) => power.emit("shutdown")],
    ["SIGTERM", () => process.emit("SIGTERM")],
  ])("shuts down fully and without a question for %s", async (_name, terminate) => {
    const { confirm, exited, mode, power, routing, shutdown, stopped, window } = fixture(
      async () => ({ ...nothing, hostsHome: true }),
    );
    routing.attach(mode);
    terminate(power);
    expect(shutdown.requested).toBe(true);
    await exited();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    click(menuItem(routing.actions, "quit"));
    expect(window.hide).not.toHaveBeenCalled();
  });
});

describe("Dock", () => {
  it("hides again when Electron ignored a hide that followed a show too closely", () => {
    const { advance, docked, mode } = fixture();
    mode.windowVisibility(true);
    mode.windowVisibility(false);
    expect(docked()).toBe(true);
    advance(dockHideRetryMs);
    expect(docked()).toBe(false);
  });

  it("keeps the Dock icon when the window came back before the retry", () => {
    const { advance, docked, mode } = fixture();
    mode.windowVisibility(true);
    mode.windowVisibility(false);
    mode.windowVisibility(true);
    advance(dockHideRetryMs);
    expect(docked()).toBe(true);
  });
});

describe("quit confirmation", () => {
  it("needs none when this Mac works for no Home and nothing could be using it", () => {
    expect(quitCompletelyConfirmation(nothing)).toBeNull();
  });

  it("asks in the design's words whenever a quit would stop something", () => {
    expect(quitCompletelyConfirmation({ ...nothing, deviceHomes: ["Office"] })).toEqual({
      message: "Quit Opensteer?",
      detail: "Agents can’t use this Mac until you open it again.",
    });
    expect(quitCompletelyConfirmation({ ...nothing, lines: ["Running: Book flights"] })).not.toBe(
      null,
    );
  });

  it("adds that this Mac is the Home, and when it cannot tell what is using it", () => {
    expect(quitCompletelyConfirmation({ ...nothing, hostsHome: true, known: false })?.detail).toBe(
      "Agents can’t use this Mac until you open it again. This Mac is your Home, so your phone and other devices can’t reach it until then either. Opensteer can’t tell right now whether agents are using this Mac.",
    );
  });
});

it("remembers that the menu bar was explained", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "background-notice-"));
  directories.push(directory);
  const store = backgroundNoticeFileStore(path.join(directory, "menu-bar-notice.json"));
  await expect(store.seen()).resolves.toBe(false);
  await store.markSeen();
  await expect(store.seen()).resolves.toBe(true);
});
