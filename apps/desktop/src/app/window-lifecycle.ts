export interface DesktopWindowLifecycleApplication {
  on(event: "window-all-closed", listener: () => void): void;
}

/** A closed shell leaves background computer lending and the tray running. */
export function keepDesktopAliveWithoutWindows(
  application: DesktopWindowLifecycleApplication,
): void {
  application.on("window-all-closed", () => undefined);
}
