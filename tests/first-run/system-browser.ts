/**
 * The system browser's place in the Mac app, for a journey with no person at the browser: the
 * app's `shell.openExternal` is where macOS would take over, so it is replaced by one short call
 * that returns at once and names each address it is given in the main process's console. The
 * journey then waits on that console message, an event, so no call into the app stays open
 * across whatever the app does meanwhile (a call left open is torn down with the app's main
 * context, and its rejection would hide the trial's real result).
 */

import { installOpenedMarker } from "./remote.js";

/** How the replaced openExternal names an address in the app's main-process console. */
export const openedMarker = "first-run-journey opened ";

/** What of Playwright's `ElectronApplication` this needs. */
export interface ElectronAppCalls {
  evaluate<A>(
    install: (electron: { shell: { openExternal: unknown } }, marker: A) => void,
    marker: A,
  ): Promise<void>;
  waitForEvent(
    event: "console",
    options: { predicate: (message: { text(): string }) => boolean; timeout: number },
  ): Promise<{ text(): string }>;
}

/**
 * Replaces the app's openExternal, then does `press` and returns the first address under
 * `prefix` the app opened because of it. A failure of either the press or the wait is this
 * step's failure, awaited here, never an unheard rejection.
 */
export async function openedByPress(
  app: ElectronAppCalls,
  prefix: string,
  press: () => Promise<void>,
  timeout: number,
): Promise<string> {
  await app.evaluate(installOpenedMarker, openedMarker);
  const opened = app.waitForEvent("console", {
    predicate: (message) => message.text().startsWith(`${openedMarker}${prefix}`),
    timeout,
  });
  const [message] = await Promise.all([opened, press()]);
  return message.text().slice(openedMarker.length);
}
