import type { MobileNotificationPort } from "./notification-port.js";
import {
  shouldPresentNotification,
  type NotificationDestination,
  type VisibleThread,
} from "./notification-routing.js";
import type { PushRegistration } from "./push-registration.js";

/**
 * Notifications as the rest of the app sees them: one registration, and the
 * Thread currently on screen.
 *
 * The screen a person is looking at is the only thing that changes how an
 * arriving notification behaves, and it is not React state — the presentation
 * handler runs outside the tree, before any render — so it is held here and
 * the Thread screen reports its own comings and goings.
 */
export class MobileNotifications {
  readonly registration: PushRegistration;

  readonly #port: MobileNotificationPort;
  #visible: VisibleThread | null = null;
  /** Whether the open Thread is showing its latest activity, not older history. */
  #atLatest = false;

  constructor(options: {
    readonly port: MobileNotificationPort;
    readonly registration: PushRegistration;
  }) {
    this.#port = options.port;
    this.registration = options.registration;
    // Installed here rather than in `start`, because a notification that
    // arrives before the handler exists is discarded by the platform, not
    // queued — and `start` has to wait for this device's storage first.
    this.#port.presentWhen((payload) =>
      shouldPresentNotification(payload, this.#visible, this.#atLatest),
    );
  }

  /** Registers this phone, if this build, this Account and this phone allow it. */
  async start(): Promise<void> {
    // The channel first: on Android it decides how an arrival behaves and what
    // a person sees in the system's own settings, and it has to exist before
    // the first notification rather than be created by the one that finds it
    // missing.
    await this.#port.prepare();
    await this.registration.start();
  }

  /** Every notification tap, including the one that cold-started the process. */
  onOpened(listener: (destination: NotificationDestination) => void): () => void {
    return this.#port.onOpened(listener);
  }

  /**
   * Called by the Thread screen while it is on screen. Opening a Thread answers
   * everything already delivered about it, so those are cleared; while it stays
   * open, a new one for the same Thread arrives without interrupting.
   */
  enterThread(visible: VisibleThread): () => void {
    this.#visible = visible;
    // Where in the conversation they are is not known until the transcript
    // says so, and until then an arriving alert is worth showing.
    this.#atLatest = false;
    void this.#port.clearThread(visible);
    return () => {
      if (this.#visible === visible) {
        this.#visible = null;
        this.#atLatest = false;
      }
    };
  }

  /**
   * Reported by the open Thread as the reader moves through it. Somebody
   * scrolled back into older history is not watching new work arrive, so an
   * alert about it is still worth showing.
   *
   * The report names its own Thread: a pane that has since left the screen can
   * still report its last position, and it is not what the reader is looking at.
   */
  readingLatest(thread: VisibleThread, atLatest: boolean): void {
    const visible = this.#visible;
    if (
      visible === null ||
      visible.deploymentId !== thread.deploymentId ||
      visible.threadId !== thread.threadId
    ) {
      return;
    }
    this.#atLatest = atLatest;
  }

  /** What the person is looking at, for the presentation rule. */
  visibleThread(): VisibleThread | null {
    return this.#visible;
  }

  stop(): void {
    this.registration.stop();
  }
}
