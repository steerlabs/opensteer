export interface DesktopWindowHandle {
  destroy(): void;
  focus(): void;
  isDestroyed(): boolean;
  show(): void;
}

export interface DesktopWindowFactory {
  /**
   * Creates the one app window. Closing it hides it: its page is where the
   * person's notifications arrive, so it lives as long as the app does and is
   * destroyed only by quitting.
   */
  create(onClosed: () => void, options: { readonly show: boolean }): Promise<DesktopWindowHandle>;
}

export interface DesktopMainServices {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class DesktopMainProcess {
  readonly #onWindowClosed: () => void;
  readonly #onServiceError: (error: Error) => void;
  readonly #services: DesktopMainServices;
  readonly #windows: DesktopWindowFactory;
  #started = false;
  #stopPromise: Promise<void> | undefined;
  #serviceStartPromise: Promise<void> | undefined;
  #window: DesktopWindowHandle | null = null;

  constructor(options: {
    readonly onServiceError?: (error: Error) => void;
    readonly onWindowClosed?: () => void;
    readonly services: DesktopMainServices;
    readonly windows: DesktopWindowFactory;
  }) {
    this.#onServiceError = options.onServiceError ?? (() => undefined);
    this.#onWindowClosed = options.onWindowClosed ?? (() => undefined);
    this.#services = options.services;
    this.#windows = options.windows;
  }

  async start(options: { readonly openWindow?: boolean } = {}): Promise<void> {
    if (this.#started || this.#stopPromise)
      throw new Error("Desktop main process already started.");
    this.#started = true;
    // A launch that should not show a window, such as at login, still creates
    // it hidden, so notifications reach the person from the moment the app runs.
    try {
      await this.#openWindow({ show: options.openWindow !== false });
    } catch (error) {
      this.#started = false;
      throw error;
    }
    let starting: Promise<void>;
    try {
      starting = this.#services.start();
    } catch (error) {
      this.#reportServiceError(error);
      return;
    }
    this.#serviceStartPromise = starting;
    void starting
      .catch((error: unknown) => this.#reportServiceError(error))
      .finally(() => {
        if (this.#serviceStartPromise === starting) this.#serviceStartPromise = undefined;
      });
  }

  async activate(): Promise<void> {
    if (!this.#started || this.#stopPromise) return;
    if (!this.#window || this.#window.isDestroyed()) await this.#openWindow({ show: true });
    else {
      this.#window.show();
      this.#window.focus();
    }
  }

  focus(): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    window.show();
    window.focus();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    const stopping = this.#stopPromise;
    void stopping.catch(() => {
      if (this.#stopPromise === stopping) this.#stopPromise = undefined;
    });
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    await this.#serviceStartPromise?.catch(() => undefined);
    await this.#services.stop();
    this.#started = false;
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  #reportServiceError(error: unknown): void {
    try {
      this.#onServiceError(
        error instanceof Error ? error : new Error("Optional local desktop services failed."),
      );
    } catch {
      // Diagnostics cannot take down the trusted Desktop shell.
    }
  }

  async #openWindow(options: { readonly show: boolean }): Promise<void> {
    const existing = this.#window;
    if (existing && !existing.isDestroyed()) return;
    let created: DesktopWindowHandle | undefined;
    created = await this.#windows.create(() => {
      if (this.#window !== created) return;
      this.#window = null;
      this.#onWindowClosed();
    }, options);
    if (!this.#started || this.#stopPromise) {
      created.destroy();
      return;
    }
    this.#window = created;
  }
}
