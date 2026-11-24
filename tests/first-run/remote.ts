/**
 * Every function the first-run journey hands to another process to run: Electron's main process
 * (`electronApplication.evaluate`) or the app's page (`page.evaluate`, `page.waitForFunction`).
 * Playwright sends a function's source, not the function, so each runs with nothing but its
 * arguments and its process's own globals: no import, no variable around it, and none of the
 * helpers the loader that compiled this file adds (`__name`). `remote.test.ts` loads this module
 * through the same loader the VM runs the journey with and runs each one that way on this Mac.
 *
 * Each is a named export so the test can find it; a new one goes here, never inline.
 */

/** Main process: the app's `shell.openExternal` names each address in the console instead. */
export function installOpenedMarker(
  electron: { shell: { openExternal: unknown } },
  marker: string,
): void {
  electron.shell.openExternal = async (url: string) => {
    console.log(`${marker}${url}`);
  };
}

/** Main process: macOS hands an app the address of a scheme it registered as `open-url`. */
export function emitOpenUrl(
  electron: { app: { emit(event: string, ...args: unknown[]): boolean } },
  url: string,
): void {
  // A method, not an arrow assigned to a name: the loader wraps a named arrow in its `__name`.
  electron.app.emit("open-url", { preventDefault() {} }, url);
}

/** Main process: quit as the app quits. */
export function quitApp(electron: { app: { quit(): void } }): void {
  electron.app.quit();
}

interface DesktopWindow {
  readonly opensteerDesktop: {
    getDeploymentAccessSnapshot(): Promise<{
      readonly personalAccountLink: { readonly status: string };
      readonly personalSetup: { readonly state: string } | null;
      readonly deployments: readonly {
        readonly onThisComputer: boolean;
        readonly status: string;
      }[];
    }>;
  };
}

/** Page: the Mac app's own account-link state for this Mac's Home. */
export async function accountLinkStatus(): Promise<string> {
  const snapshot = await (
    window as unknown as DesktopWindow
  ).opensteerDesktop.getDeploymentAccessSnapshot();
  return snapshot.personalAccountLink.status;
}

/** Page: this Mac's Home is set up and attached. */
export async function homeIsReady(): Promise<boolean> {
  const snapshot = await (
    window as unknown as DesktopWindow
  ).opensteerDesktop.getDeploymentAccessSnapshot();
  return (
    snapshot.personalSetup?.state === "ready" &&
    snapshot.deployments.some((row) => row.onThisComputer && row.status === "connected")
  );
}

/** Page: the title of the setup step showing, once it is one the walk knows and not `previous`. */
export function nextKnownSetupStep(input: {
  readonly known: readonly string[];
  readonly previous: string | null;
}): string | null {
  const title = document.querySelector(".setup-frame__title")?.textContent?.trim() ?? "";
  return input.known.includes(title) && title !== input.previous ? title : null;
}

/** Page: the phone step has come to its end: the helper sentence, or a failure to add. */
export function phoneStepSettled(sentence: string): boolean {
  const text = document.body.innerText;
  return text.includes(sentence) || /Couldn[’']t add/u.test(text);
}
