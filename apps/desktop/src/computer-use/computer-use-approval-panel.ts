import { randomBytes } from "node:crypto";
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Screen,
  WebContents,
  WebPreferences,
} from "electron";
import {
  DesktopComputerUseApprovalPresentationSchema,
  type DesktopComputerUseApprovalPresentation,
} from "@opensteer/protocol/desktop";
import type { ComputerAppApprovalPresentation } from "../computer-app-approval-service.js";
import { configureDesktopWindowNavigation } from "../app/electron-window.js";
import { DesktopAppOriginPolicy } from "../app/navigation-policy.js";

const approvalPanelUrl = "app://opensteer/computer-use/approve";
const panelWidth = 480;
// Consent text scrolls within the panel while the answer buttons stay visible.
const panelHeight = 400;

export interface ComputerUseApprovalPanelOptions {
  readonly platform?: NodeJS.Platform;
  readonly screen: Pick<Screen, "getPrimaryDisplay">;
  readonly webPreferences: WebPreferences;
  readonly windowFactory: (options: BrowserWindowConstructorOptions) => BrowserWindow;
}

interface OpenApproval {
  /** Closes the panel unanswered. */
  readonly dismiss: (error: Error) => void;
  readonly presentation: DesktopComputerUseApprovalPresentation;
  readonly settle: (allow: boolean) => void;
  readonly window: BrowserWindow;
}

/**
 * The window that replaces the message box for every computer app.
 *
 * It floats above everything but never takes the keyboard: it is created
 * hidden, loaded, and shown inactive. A request arrives whenever a task makes
 * one, usually while the person is typing somewhere else, and a panel that
 * took focus would turn their next Return or Space into an answer they never
 * gave. Inside the page the key that lands first is `Don't allow`, for the
 * same reason, once the person does click into it.
 *
 * The page is handed a token and reads its presentation back over the bridge,
 * so nothing a renderer says decides which app, access or Deployment the
 * person is being asked about — and only the panel's own page may read or
 * answer it: the token is bound to that window's contents.
 */
export class ComputerUseApprovalPanel {
  readonly #open = new Map<string, OpenApproval>();
  readonly #options: ComputerUseApprovalPanelOptions;
  #closed = false;

  constructor(options: ComputerUseApprovalPanelOptions) {
    this.#options = options;
  }

  /**
   * Shows one approval and resolves with the person's answer. A window the
   * person closes is a refusal: dismissing a question is not consent to it.
   *
   * Aborting `signal` — the approval ended somewhere else — and quitting both
   * close the panel without an answer: the promise rejects, and nothing is
   * declined for a question the person never finished reading.
   */
  async ask(presentation: ComputerAppApprovalPresentation, signal?: AbortSignal): Promise<boolean> {
    if (this.#closed) throw new Error("Opensteer is quitting, so this approval was not shown.");
    if (signal?.aborted) throw new Error("This approval ended before it was shown.");
    const token = randomBytes(32).toString("base64url");
    const parsed = DesktopComputerUseApprovalPresentationSchema.parse({ ...presentation, token });
    const workArea = this.#options.screen.getPrimaryDisplay().workArea;
    const platform = this.#options.platform ?? process.platform;
    const window = this.#options.windowFactory({
      alwaysOnTop: true,
      frame: false,
      fullscreenable: false,
      height: panelHeight,
      hiddenInMissionControl: true,
      maximizable: false,
      minimizable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      title: "Computer use",
      transparent: true,
      ...(platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: this.#options.webPreferences,
      width: panelWidth,
      x: workArea.x + Math.round((workArea.width - panelWidth) / 2),
      y: workArea.y + Math.round((workArea.height - panelHeight) / 2),
    });
    configureDesktopWindowNavigation(window.webContents, new DesktopAppOriginPolicy());
    window.setAlwaysOnTop(true, "floating");
    return new Promise<boolean>((resolvePromise, rejectPromise) => {
      let settled = false;
      const onAbort = (): void =>
        fail(new Error("This approval ended somewhere else, so its panel closed."));
      const finish = (): void => {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.#open.delete(token);
        if (!window.isDestroyed()) window.destroy();
      };
      const settle = (allow: boolean): void => {
        if (settled) return;
        finish();
        resolvePromise(allow);
      };
      // A panel that could not be shown, whose page died, that was withdrawn or
      // closed by quitting asked nothing: it is not a refusal, and the request
      // stays pending to be asked again.
      const fail = (error: Error): void => {
        if (settled) return;
        finish();
        rejectPromise(error);
      };
      this.#open.set(token, { dismiss: fail, presentation: parsed, settle, window });
      signal?.addEventListener("abort", onAbort, { once: true });
      window.once("closed", () => settle(false));
      // The window is frameless, so a page that is gone leaves nothing to
      // click, and the question would hold every later approval behind it.
      window.webContents.once("render-process-gone", () =>
        fail(new Error("The Computer use approval panel stopped before it was answered.")),
      );
      void window
        .loadURL(`${approvalPanelUrl}?token=${encodeURIComponent(token)}`)
        .then(() => {
          if (window.isDestroyed()) return;
          window.showInactive();
        })
        .catch((error: unknown) =>
          fail(
            new Error("The Computer use approval panel could not load the bundled application.", {
              cause: error,
            }),
          ),
        );
    });
  }

  /**
   * What the panel renders, for the token it was opened with, asked by the
   * panel's own page. Any other renderer is told the approval is not open,
   * which is true for it.
   */
  presentation(token: string, sender: WebContents): DesktopComputerUseApprovalPresentation {
    return this.#openFor(token, sender).presentation;
  }

  /**
   * The person's answer, from the panel's own page. A token is answered once
   * and then forgotten; no other window can answer it for them.
   */
  respond(token: string, allow: boolean, sender: WebContents): void {
    this.#openFor(token, sender).settle(allow);
  }

  #openFor(token: string, sender: WebContents): OpenApproval {
    const open = this.#open.get(token);
    if (!open || open.window.isDestroyed() || open.window.webContents !== sender) {
      throw new Error("That Computer use approval is no longer open.");
    }
    return open;
  }

  /**
   * Closes every open question unanswered, which is what quitting means for
   * one, and shows no further question after it. Nothing is declined: the
   * next launch asks again.
   */
  close(): void {
    this.#closed = true;
    for (const open of Array.from(this.#open.values())) {
      open.dismiss(new Error("Opensteer is quitting, so this approval was not answered."));
    }
  }
}
