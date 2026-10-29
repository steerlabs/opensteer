import {
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunnerDescriptor } from "@opensteer/protocol";

/** A private local signal for supervisors that already have filesystem access to the Runner. */
export class RunnerReadinessFile {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async initialize(): Promise<void> {
    await securePrivateDirectory(dirname(this.#path));
    await rm(this.#path, { force: true });
  }

  connected(bootId: RunnerDescriptor["bootId"]): Promise<void> {
    return this.#enqueue(() =>
      replacePrivateFileAtomically(
        this.#path,
        `${JSON.stringify({ bootId, pid: process.pid, state: "connected", version: 1 })}\n`,
      ),
    );
  }

  disconnected(): Promise<void> {
    return this.#enqueue(() => rm(this.#path, { force: true }));
  }

  async settle(): Promise<void> {
    await this.#tail;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    this.#tail = this.#tail.then(operation, operation);
    return this.#tail;
  }
}
