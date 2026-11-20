import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { App, PowerMonitor } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backgroundNoticeFileStore,
  DesktopBackgroundMode,
  quitCompletelyConfirmation,
  type QuitWork,
} from "./background-mode.js";
import { DesktopShutdown } from "./desktop-shutdown.js";

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

const nothing: QuitWork = { hostsHome: false, deviceHomes: [], activity: [] };

function fixture(work: QuitWork = nothing, answer = true) {
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
  const dock = { hide: vi.fn(), show: vi.fn() };
  let seen = false;
  const notice = {
    seen: vi.fn(async () => seen),
    markSeen: vi.fn(async () => {
      seen = true;
    }),
    show: vi.fn(),
  };
  const confirm = vi.fn(async () => answer);
  const mode = new DesktopBackgroundMode({
    shutdown,
    window,
    dock,
    notice,
    work: async () => work,
    confirm,
    log,
  });
  const exited = () =>
    vi.waitFor(() => expect(application.exit).toHaveBeenCalledWith(0), { timeout: 2_000 });
  return { application, confirm, dock, exited, mode, notice, power, shutdown, stopped, window };
}

describe("quit routing", () => {
  it("puts the app away on Cmd+Q and keeps every service running", async () => {
    const { application, dock, mode, notice, shutdown, stopped, window } = fixture();
    mode.quitRequested();
    mode.quitRequested();
    await vi.waitFor(() => expect(notice.markSeen).toHaveBeenCalled());
    expect(window.hide).toHaveBeenCalledTimes(2);
    expect(dock.hide).toHaveBeenCalled();
    expect(notice.show).toHaveBeenCalledTimes(1);
    expect(shutdown.requested).toBe(false);
    expect(stopped).not.toHaveBeenCalled();
    expect(application.exit).not.toHaveBeenCalled();

    mode.windowShown();
    expect(dock.show).toHaveBeenCalledTimes(1);
  });

  it("runs the full ordered shutdown for Quit Opensteer Completely", async () => {
    const { confirm, exited, mode, shutdown, stopped } = fixture();
    await expect(mode.quitCompletely()).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(shutdown.requested).toBe(true);
    await exited();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("asks first when this Mac hosts a Home, and stays running when the person declines", async () => {
    const declined = fixture({ ...nothing, hostsHome: true }, false);
    await expect(declined.mode.quitCompletely()).resolves.toBe(false);
    expect(declined.confirm).toHaveBeenCalledWith({
      message: "Quit Opensteer completely?",
      detail: expect.stringContaining("This Mac is your Home."),
    });
    expect(declined.shutdown.requested).toBe(false);

    const accepted = fixture({ ...nothing, hostsHome: true }, true);
    await expect(accepted.mode.quitCompletely()).resolves.toBe(true);
    await accepted.exited();
  });

  it.each([
    ["logout, restart or power off", (power: EventEmitter) => power.emit("shutdown")],
    ["SIGTERM", () => process.emit("SIGTERM")],
  ])("shuts down fully and without a question for %s", async (_name, terminate) => {
    const { confirm, exited, mode, power, shutdown, stopped, window } = fixture({
      ...nothing,
      hostsHome: true,
    });
    terminate(power);
    expect(shutdown.requested).toBe(true);
    await exited();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    mode.quitRequested();
    expect(window.hide).not.toHaveBeenCalled();
  });

  it("lets an update install run the full shutdown, then hand off", async () => {
    const { mode, shutdown, stopped } = fixture({ ...nothing, hostsHome: true });
    const install = vi.fn();
    void shutdown.requestUpdate(install);
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(stopped).toHaveBeenCalledTimes(1);
    await expect(mode.quitCompletely()).resolves.toBe(true);
  });
});

describe("quit confirmation", () => {
  it("needs none when nothing would stop that matters", () => {
    expect(quitCompletelyConfirmation(nothing)).toBeNull();
    expect(quitCompletelyConfirmation({ ...nothing, deviceHomes: ["Office"] })).toBeNull();
  });

  it("names the Home and what is using this Mac", () => {
    expect(
      quitCompletelyConfirmation({
        hostsHome: true,
        deviceHomes: [],
        activity: ["Running: Book flights"],
      })?.detail,
    ).toBe(
      "This Mac is your Home. Quitting stops it: your phone and other devices can’t reach it, and agents stop until you open Opensteer again. Using this Mac now: Running: Book flights.",
    );
    expect(
      quitCompletelyConfirmation({
        hostsHome: false,
        deviceHomes: ["Office", "Lab", "Studio"],
        activity: ["An agent is using apps on this Mac"],
      })?.detail,
    ).toBe(
      "Agents are using this Mac. Quitting stops them and disconnects this Mac from Office, Lab and Studio. Using this Mac now: An agent is using apps on this Mac.",
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
