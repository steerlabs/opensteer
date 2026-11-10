import type { PersonFillAccountView } from "@opensteer/protocol";
import type { BrowserCommand } from "../host/client.js";
import { BrowserEditingStore } from "../host/browser-editing.js";

/** The Chat's mock page, whose fields act as a sign-in form so clients can show filling without a Mac. */
export const mockSignInPageTitle = "Weekend ideas";
const consumerToken = "00000000-0000-4000-8000-000000000001";
const logins: readonly Omit<PersonFillAccountView, "ready">[] = [
  {
    id: "00000000-0000-4000-8000-00000000f001",
    revision: 1,
    username: "alex.rivera@gmail.com",
    label: null,
  },
  {
    id: "00000000-0000-4000-8000-00000000f002",
    revision: 1,
    username: "alex@studio.co",
    label: null,
  },
];

/**
 * Remote editing on the mock sign-in page: a tap anywhere on it focuses a
 * password field and offers the saved logins, and a fill lands a moment later.
 * Every other mock page stays without editing, as a page from an older
 * runtime is.
 */
export class MockSignInPage {
  readonly editing = new BrowserEditingStore((sessionId, _surfaceId, command) =>
    this.#send(sessionId, command),
  );
  /** Logins this phone already confirmed, which fill again without asking. */
  readonly #confirmed = new Set<string>();
  readonly #send: (sessionId: string, command: BrowserCommand) => void;

  constructor(send: (sessionId: string, command: BrowserCommand) => void) {
    this.#send = send;
  }

  /** Answers a command meant for the sign-in page; false leaves it to the browser. */
  command(sessionId: string, command: BrowserCommand, title: string | undefined): boolean {
    if (command.type === "autofill.fill") {
      this.#confirmed.add(command.loginId);
      const offer = { surfaceId: command.surfaceId, consumerToken, offerId: command.offerId };
      setTimeout(() => {
        this.editing.receive(sessionId, {
          type: "browser.autofill.result",
          ...offer,
          status: "filled",
        });
        this.editing.receive(sessionId, { type: "browser.autofill.withdrawn", ...offer });
      }, 1_200);
      return true;
    }
    if (command.type !== "input.pointer" || command.action !== "down") return false;
    if (title !== mockSignInPageTitle) return false;
    const { surfaceId } = command;
    if (!this.editing.target(sessionId, surfaceId).get().negotiated)
      this.editing.negotiate(sessionId, 1, surfaceId);
    const y = Math.min(command.y, 0.95);
    this.editing.receive(sessionId, {
      type: "browser.editing",
      surfaceId,
      context: {
        contextId: crypto.randomUUID(),
        field: { kind: "text", multiline: false, sensitive: true },
        caret: { x: command.x, y, height: 0.04 },
      },
    });
    this.editing.receive(sessionId, {
      type: "browser.autofill.offer",
      surfaceId,
      consumerToken,
      offerId: crypto.randomUUID(),
      role: "password",
      geometryRevision: command.geometryRevision ?? 0,
      anchor: { x: 0.05, y, width: 0.5, height: 0.05 },
      accounts: logins.map((login) => ({ ...login, ready: this.#confirmed.has(login.id) })),
    });
    return false;
  }
}
