import { DeploymentIdSchema } from "@opensteer/core";
import { createHttpHostApiClient, unwrapRpcResult } from "@opensteer/client/host";
import { includeDeviceAccessRequests } from "@opensteer/protocol";
import type {
  DeploymentAccessDeployment,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { createDesktopHostFetch } from "./desktop-host-transport.js";

export interface ComputerFacts {
  /** The Mac this Opensteer lives on, as its Host names it; null where the Host doesn't say. */
  readonly homeName: string | null;
  readonly needsYou: number;
  readonly unread: boolean;
}

export async function readComputerFacts(
  bridge: Pick<OpensteerDesktopBridge, "cancelHostRequest">,
  computer: DeploymentAccessDeployment,
  fetch?: typeof globalThis.fetch,
): Promise<ComputerFacts> {
  const rpc = createHttpHostApiClient({
    baseUrl: new URL(computer.canonicalOrigin),
    fetch: createDesktopHostFetch(
      bridge,
      computer.canonicalOrigin,
      DeploymentIdSchema.parse(computer.id),
      fetch,
    ),
    onAuthenticationRequired: () => undefined,
  });
  const attention = await rpc["attention.get"](includeDeviceAccessRequests).then(unwrapRpcResult);
  return {
    homeName: attention.homeName ?? null,
    needsYou: attention.needsYou,
    unread: attention.unread,
  };
}

/** One key for a set of computers: the same set, read through the same origins. */
export function computersKey(computers: readonly DeploymentAccessDeployment[]): string {
  return computers
    .map((row) => `${row.id}:${row.canonicalOrigin}`)
    .sort()
    .join(",");
}

/**
 * What each listed personal Opensteer last said about itself, held for as long
 * as the app runs, so a list of places opens already drawn and only refreshes
 * behind what it shows. One that can't be reached keeps what it said last.
 */
export class ComputerFactsStore {
  #facts: ReadonlyMap<string, ComputerFacts> = new Map();
  #reading: { readonly key: string; readonly done: Promise<void> } | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #read: (computer: DeploymentAccessDeployment) => Promise<ComputerFacts>;

  constructor(read: (computer: DeploymentAccessDeployment) => Promise<ComputerFacts>) {
    this.#read = read;
  }

  readonly getSnapshot = (): ReadonlyMap<string, ComputerFacts> => this.#facts;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Reads these computers again; a read of the same set already under way is shared. */
  refresh(computers: readonly DeploymentAccessDeployment[]): Promise<void> {
    const key = computersKey(computers);
    if (this.#reading?.key === key) return this.#reading.done;
    const done: Promise<void> = Promise.allSettled(computers.map((row) => this.#read(row))).then(
      (results) => {
        if (this.#reading?.done !== done) return;
        this.#reading = null;
        const held = this.#facts;
        this.#facts = new Map(
          computers.flatMap((row, index) => {
            const result = results[index];
            const facts = result?.status === "fulfilled" ? result.value : held.get(row.id);
            return facts ? [[row.id, facts] as const] : [];
          }),
        );
        for (const listener of this.#listeners) listener();
      },
    );
    this.#reading = { key, done };
    return done;
  }
}
