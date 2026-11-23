import { homeFailureText } from "./failure-text.js";
import type { PersonalAccountLinkStatus } from "@opensteer/protocol";
import type { HostClient } from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";
import { resumePersonalHostAccountLink } from "./personal-remote-access.js";

/**
 * A Home on its own server and its Opensteer Account link. It has no Remote
 * access, so the link is read and changed on its own: whether it is linked,
 * and linking or unlinking it, never wait on a tunnel.
 */
export interface HomeAccountLinkSnapshot {
  readonly status: PersonalAccountLinkStatus | null;
  /** Reading the link failed. */
  readonly error: string | null;
  /** The last link or unlink failed, in a sentence a person can read. */
  readonly actionError: string | null;
  readonly working: boolean;
}

/** Links through whatever this app uses to reach the person's Account. */
export type HomeAccountLinkCourier = (
  authorityEnvelope: PersonalAccountLinkStatus["authorityEnvelope"],
) => Promise<void>;

type HomeAccountLinkHost = Pick<HostClient, "dispatch" | "rpc" | "subscribePersonalRemoteAccess">;

export class HomeAccountLinkClient {
  readonly #client: HomeAccountLinkHost;
  readonly #listeners = new Set<() => void>();
  #snapshot: HomeAccountLinkSnapshot = {
    status: null,
    error: null,
    actionError: null,
    working: false,
  };

  constructor(client: HomeAccountLinkHost) {
    this.#client = client;
  }

  getSnapshot = (): HomeAccountLinkSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Reads now and whenever the Home says its link changed. */
  start(): () => void {
    let stopped = false;
    const read = () => {
      if (!stopped) void this.refresh();
    };
    const stop = this.#client.subscribePersonalRemoteAccess(read);
    read();
    return () => {
      stopped = true;
      stop();
    };
  }

  async refresh(): Promise<void> {
    try {
      const status = unwrapRpcResult(await this.#client.rpc["personal.accountLink.get"]({}));
      this.#publish({ status, error: null });
    } catch (cause) {
      this.#publish({
        error: words(cause, "This Home's Opensteer account link couldn't be read."),
      });
    }
  }

  /** Links this Home, or finishes a link it already holds. */
  async link(courier: HomeAccountLinkCourier): Promise<void> {
    const status = this.#snapshot.status;
    if (!status || this.#snapshot.working) return;
    await this.#act(async () => {
      if (status.accountLink?.state === "activating")
        await resumePersonalHostAccountLink(this.#client);
      else await courier(status.authorityEnvelope);
    }, "Linking didn't finish. Try again.");
  }

  async unlink(): Promise<void> {
    if (!this.#snapshot.status?.accountLink || this.#snapshot.working) return;
    await this.#act(async () => {
      const result = await this.#client.dispatch({
        idempotencyKey: mutationIdempotencyKey("account-unlink"),
        type: "personal.accountLink.unlink",
      });
      if (result.type !== "personal.accountLink.unlink")
        throw new Error("Unexpected Account link response");
    }, "Unlinking didn't finish. Try again.");
  }

  async #act(step: () => Promise<void>, fallback: string): Promise<void> {
    this.#publish({ actionError: null, working: true });
    try {
      await step();
      this.#publish({ working: false });
    } catch (cause) {
      this.#publish({ actionError: words(cause, fallback), working: false });
    }
    await this.refresh();
  }

  #publish(patch: Partial<HomeAccountLinkSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

export interface HomeAccountLinkView {
  readonly title: string;
  readonly sentence: string;
  readonly action: {
    readonly id: "link" | "unlink";
    readonly label: string;
    /** Asked before an unlink, which signs Account devices out of this Home. */
    readonly confirm: string | null;
  } | null;
}

/** What the card says, the same on every surface. */
export function homeAccountLinkView(snapshot: HomeAccountLinkSnapshot): HomeAccountLinkView {
  const status = snapshot.status;
  if (!status)
    return {
      title: "Opensteer account",
      sentence: snapshot.error ?? "Checking this Home's Opensteer account link…",
      action: null,
    };
  const link = status.accountLink;
  if (status.managed)
    return {
      title: "Linked to your Opensteer account",
      sentence:
        "This Cloud Computer stays linked to the Opensteer account that owns it. Deleting the Cloud Computer ends the link.",
      action: null,
    };
  if (link?.state === "activating")
    return {
      title: "Finishing the link",
      sentence: "This Home is almost linked to your Opensteer account.",
      action: { id: "link", label: "Finish linking", confirm: null },
    };
  if (link)
    return {
      title: "Linked to your Opensteer account",
      sentence: "It's in the Opensteer app wherever you sign in with that account.",
      action: {
        id: "unlink",
        label: "Unlink",
        confirm:
          "Devices signed in to this Home through your Opensteer account will be signed out. Unlink?",
      },
    };
  return {
    title: "Not linked to an Opensteer account",
    sentence:
      "Link this Home to find it in the Opensteer app on any device you sign in on, and to get its notifications.",
    action: { id: "link", label: "Link account", confirm: null },
  };
}

function words(cause: unknown, fallback: string): string {
  return homeFailureText(cause, fallback);
}
