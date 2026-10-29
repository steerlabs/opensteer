import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ComputerAppSetupPanel } from "./computer-app-setup-panel.js";
import { ComputerUseApprovalPanel } from "./computer-use-approval-panel.js";
import { ComputerUsePermissionsPanel } from "./computer-use-permissions-panel.js";

const presentation = {
  access: "read-write",
  accessLabel: "Can see and control",
  accessSummary: "Agents can see the app and click, type, scroll, press keys, and open it.",
  app: {
    bundleId: "com.apple.Notes",
    displayName: "Notes",
    iconPng: null,
    path: "/System/Applications/Notes.app",
    reason: null,
    risk: "standard",
  },
  deploymentName: "Alex's Deployment",
  kind: "app",
  machineName: "Alex's MacBook Pro",
  reason: "To add the meeting notes to the shared note.",
  threadTitle: "Plan the offsite",
  workspaceName: "Main",
} as const;

describe("ComputerUseApprovalPanel", () => {
  it("opens one centered window without taking the keyboard", async () => {
    const harness = approvalHarness();

    const answer = harness.panel.ask(presentation);
    await vi.waitFor(() => expect(harness.window.showInactive).toHaveBeenCalled());

    expect(harness.options[0]).toMatchObject({
      alwaysOnTop: true,
      frame: false,
      height: 400,
      resizable: false,
      show: false,
      type: "panel",
      width: 480,
      // Centered on the primary display's work area, not the corner.
      x: 100 + Math.round((1_200 - 480) / 2),
      y: 50 + Math.round((900 - 400) / 2),
    });
    // Shown inactive: somebody typing elsewhere must not answer it with the
    // next key they press.
    expect(harness.window.showInactive).toHaveBeenCalledOnce();
    expect(harness.window.show).not.toHaveBeenCalled();
    expect(harness.window.focus).not.toHaveBeenCalled();
    const url = harness.window.loadURL.mock.calls[0]?.[0] ?? "";
    expect(url.startsWith("app://opensteer/computer-use/approve?token=")).toBe(true);

    harness.panel.respond(harness.token(), true, harness.page);
    await expect(answer).resolves.toBe(true);
  });

  it("serves the presentation back for its own token only", async () => {
    const harness = approvalHarness();
    const answer = harness.panel.ask(presentation);
    await vi.waitFor(() => expect(harness.window.showInactive).toHaveBeenCalled());

    expect(harness.panel.presentation(harness.token(), harness.page)).toMatchObject({
      app: { displayName: "Notes" },
      token: harness.token(),
    });
    expect(() => harness.panel.presentation("someone-elses-token", harness.page)).toThrow(
      /no longer open/u,
    );

    harness.panel.respond(harness.token(), false, harness.page);
    await expect(answer).resolves.toBe(false);
  });

  it("takes an answer only from the panel's own page", async () => {
    const harness = approvalHarness();
    const answer = harness.panel.ask(presentation);
    await vi.waitFor(() => expect(harness.window.showInactive).toHaveBeenCalled());
    const otherPage = { id: 99 } as unknown as Electron.WebContents;

    // Another renderer holding the token is still not the panel the person
    // sees, so it can neither read the question nor answer it.
    expect(() => harness.panel.presentation(harness.token(), otherPage)).toThrow(/no longer open/u);
    expect(() => harness.panel.respond(harness.token(), true, otherPage)).toThrow(
      /no longer open/u,
    );

    harness.panel.respond(harness.token(), false, harness.page);
    await expect(answer).resolves.toBe(false);
  });

  it("answers a token once and then forgets it", async () => {
    const harness = approvalHarness();
    const answer = harness.panel.ask(presentation);
    await vi.waitFor(() => expect(harness.window.showInactive).toHaveBeenCalled());
    const token = harness.token();

    harness.panel.respond(token, true, harness.page);
    await expect(answer).resolves.toBe(true);

    expect(() => harness.panel.respond(token, false, harness.page)).toThrow(/no longer open/u);
    expect(harness.window.destroy).toHaveBeenCalledOnce();
  });

  it("treats a closed window as Don't allow", async () => {
    const harness = approvalHarness();
    const answer = harness.panel.ask(presentation);
    await vi.waitFor(() => expect(harness.window.showInactive).toHaveBeenCalled());

    harness.closeWindow();

    await expect(answer).resolves.toBe(false);
  });

  it("treats a page that died as no answer, and lets the question go", async () => {
    const harness = approvalHarness();
    const answer = harness.panel.ask(presentation);
    await vi.waitFor(() => expect(harness.window.showInactive).toHaveBeenCalled());
    const token = harness.token();

    harness.crashPage();

    // Not a refusal: nobody could answer, so the request is asked again later
    // rather than declined, and the frameless window does not stay behind.
    await expect(answer).rejects.toThrow(/stopped before it was answered/u);
    expect(harness.window.destroy).toHaveBeenCalledOnce();
    expect(() => harness.panel.presentation(token, harness.page)).toThrow(/no longer open/u);
  });

  it("shows nothing more once the app has quit", async () => {
    const harness = approvalHarness();
    harness.panel.close();

    await expect(harness.panel.ask(presentation)).rejects.toThrow(/quitting/u);
    expect(harness.windowFactory).not.toHaveBeenCalled();
  });

  it("closes every open question unanswered when the app quits", async () => {
    const harness = approvalHarness();
    const answer = harness.panel.ask(presentation);
    await vi.waitFor(() => expect(harness.window.showInactive).toHaveBeenCalled());

    harness.panel.close();

    // Not a refusal: the next launch asks again.
    await expect(answer).rejects.toThrow(/quitting/u);
    expect(harness.window.destroy).toHaveBeenCalled();
  });

  it("closes a question unanswered when its approval ends somewhere else", async () => {
    const harness = approvalHarness();
    const withdrawn = new AbortController();
    const answer = harness.panel.ask(presentation, withdrawn.signal);
    await vi.waitFor(() => expect(harness.window.showInactive).toHaveBeenCalled());

    withdrawn.abort();

    await expect(answer).rejects.toThrow(/ended somewhere else/u);
    expect(harness.window.destroy).toHaveBeenCalled();
  });
});

describe("ComputerUsePermissionsPanel", () => {
  it("opens one inactive panel at the contract's size", async () => {
    const harness = permissionsHarness();

    await expect(harness.panel.open()).resolves.toEqual({ opened: true });

    expect(harness.options[0]).toMatchObject({
      alwaysOnTop: true,
      frame: false,
      height: 380,
      show: false,
      type: "panel",
      width: 500,
    });
    expect(harness.window.loadURL).toHaveBeenCalledWith("app://opensteer/computer-use/permissions");
    // It floats over System Settings; it never takes the keyboard.
    expect(harness.window.showInactive).toHaveBeenCalledOnce();
    expect(harness.window.focus).not.toHaveBeenCalled();
    harness.panel.close();
  });
});

describe("ComputerAppSetupPanel", () => {
  it("lets a page that died go rather than float an empty window over the screen", async () => {
    const harness = setupHarness();
    await harness.panel.open();

    harness.crashPage();

    expect(harness.window.destroy).toHaveBeenCalledOnce();
  });

  it("ends setup when its window goes away by itself, but not when setup closed it", async () => {
    const harness = setupHarness();
    await harness.panel.open();
    harness.closeWindow();
    expect(harness.onClosed).toHaveBeenCalledOnce();

    await harness.panel.open();
    harness.panel.close();
    harness.closeWindow();
    expect(harness.onClosed).toHaveBeenCalledOnce();
  });
});

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const pageListeners = new Map<string, () => void>();
  const window = {
    destroy: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async (_url: string) => undefined),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return window;
    }),
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(),
    showInactive: vi.fn(),
    webContents: {
      on: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        pageListeners.set(event, listener);
      }),
      setWindowOpenHandler: vi.fn(),
    },
  };
  return { listeners, pageListeners, window };
}

function approvalHarness() {
  const { listeners, pageListeners, window } = fakeWindow();
  const options: BrowserWindowConstructorOptions[] = [];
  const windowFactory = vi.fn((windowOptions: BrowserWindowConstructorOptions) => {
    options.push(windowOptions);
    return window as unknown as BrowserWindow;
  });
  const panel = new ComputerUseApprovalPanel({
    platform: "darwin",
    screen: {
      getPrimaryDisplay: () =>
        ({ workArea: { height: 900, width: 1_200, x: 100, y: 50 } }) as Electron.Display,
    },
    webPreferences: { contextIsolation: true, sandbox: true },
    windowFactory,
  });
  return {
    closeWindow: () => listeners.get("closed")?.(),
    crashPage: () => pageListeners.get("render-process-gone")?.(),
    options,
    /** The panel's own contents, the one sender that may read and answer it. */
    page: window.webContents as unknown as Electron.WebContents,
    panel,
    token: () => {
      const url = window.loadURL.mock.calls[0]?.[0] ?? "";
      return new URL(url).searchParams.get("token") ?? "";
    },
    window,
    windowFactory,
  };
}

function setupHarness() {
  const { listeners, pageListeners, window } = fakeWindow();
  const onClosed = vi.fn();
  const panel = new ComputerAppSetupPanel({
    onClosed,
    platform: "darwin",
    screen: {
      getPrimaryDisplay: () =>
        ({ workArea: { height: 900, width: 1_200, x: 100, y: 50 } }) as Electron.Display,
    },
    webPreferences: { contextIsolation: true, sandbox: true },
    windowFactory: () => window as unknown as BrowserWindow,
  });
  return {
    closeWindow: () => listeners.get("closed")?.(),
    crashPage: () => pageListeners.get("render-process-gone")?.(),
    onClosed,
    panel,
    window,
  };
}

function permissionsHarness() {
  const { window } = fakeWindow();
  const options: BrowserWindowConstructorOptions[] = [];
  const windowFactory = vi.fn((windowOptions: BrowserWindowConstructorOptions) => {
    options.push(windowOptions);
    return window as unknown as BrowserWindow;
  });
  const openExternal = vi.fn(
    async (_url: string, _options: { readonly activate: boolean }) => undefined,
  );
  const panel = new ComputerUsePermissionsPanel({
    openExternal,
    platform: "darwin",
    screen: {
      getPrimaryDisplay: () =>
        ({ workArea: { height: 900, width: 1_200, x: 100, y: 50 } }) as Electron.Display,
    },
    webPreferences: { contextIsolation: true, sandbox: true },
    windowFactory,
  });
  return {
    openExternal,
    options,
    panel,
    window,
    windowFactory,
  };
}
