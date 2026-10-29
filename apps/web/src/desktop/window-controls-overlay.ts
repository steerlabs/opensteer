const overlayClassName = "window-controls-overlay";

interface WindowControlsOverlay {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlay;
}

export function initializeDesktopWindowChrome(): void {
  const root = document.documentElement;
  root.classList.add("electron-shell");
  root.classList.toggle("electron-shell--macos", navigator.platform.startsWith("Mac"));

  const overlay = (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay;
  const syncOverlay = () => {
    root.classList.toggle(overlayClassName, overlay?.visible === true);
  };

  syncOverlay();
  overlay?.addEventListener("geometrychange", syncOverlay);
}
