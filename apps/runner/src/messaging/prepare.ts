import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  IMessageHelperError,
  createIMessageAdapter,
  type IMessageCursorStore,
  type IMessageHelperPort,
} from "@opensteer/channel-imessage";
import { MessagingModule } from "@opensteer/messaging-module";
import type { RunnerMessagingModule } from "@opensteer/protocol";
import { ComputerUseBridgeError } from "../computer-apps/computer-use-bridge-client.js";
import type { ComputerUseHandler } from "../computer-apps/computer-use-handler.js";

export interface PreparedMessagingModule {
  readonly descriptor: RunnerMessagingModule;
  readonly module: MessagingModule;
}

/**
 * The `messaging` module of a Mac's own Runner: the transports only this Mac
 * can hold, which today is iMessage through its Messages. It carries no
 * adapter a Deployment's messaging service carries, so a channel reached any
 * other way never lands here, and one pinned here never lands anywhere else.
 * Without the desktop app there is no helper to read Messages, and the
 * adapter says so rather than reading it another way.
 */
export function prepareMessagingModule(options: {
  readonly computerUse: ComputerUseHandler | undefined;
  readonly dataDirectory: string;
  readonly platform: NodeJS.Platform;
}): PreparedMessagingModule | undefined {
  if (options.platform !== "darwin") return undefined;
  const module = new MessagingModule([
    createIMessageAdapter({
      cursors: new FileIMessageCursorStore(
        path.join(options.dataDirectory, "messaging", "imessage-cursors.json"),
      ),
      helper: options.computerUse ? helperPort(options.computerUse) : null,
    }),
  ]);
  return { descriptor: { capabilities: [...module.capabilities()] }, module };
}

function helperPort(computerUse: ComputerUseHandler): IMessageHelperPort {
  const refused = (error: unknown): never => {
    if (!(error instanceof ComputerUseBridgeError)) throw error;
    throw new IMessageHelperError(
      error.code === "permission-required" ||
        error.code === "delivery-unconfirmed" ||
        error.code === "outcome-unknown" ||
        error.code === "busy"
        ? error.code
        : "failed",
      error.message,
    );
  };
  return {
    account: async () => await computerUse.imessageAccount().catch(refused),
    poll: async (params) => await computerUse.imessagePoll(params).catch(refused),
    send: async (params) => await computerUse.imessageSend(params).catch(refused),
  };
}

/**
 * Each channel's place, in one private file beside this Runner's identity,
 * replaced whole on every write so a crash leaves the old place or the new
 * one, never half of either.
 */
export class FileIMessageCursorStore implements IMessageCursorStore {
  readonly #file: string;
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async read(accountId: string): Promise<string | null> {
    return (await this.#load())[accountId] ?? null;
  }

  async write(accountId: string, cursor: string): Promise<void> {
    const next = this.#writing.then(async () => {
      const all = { ...(await this.#load()), [accountId]: cursor };
      await mkdir(path.dirname(this.#file), { mode: 0o700, recursive: true });
      const staged = `${this.#file}.${process.pid}.tmp`;
      await writeFile(staged, `${JSON.stringify(all)}\n`, { mode: 0o600 });
      await rename(staged, this.#file);
    });
    this.#writing = next.catch(() => undefined);
    await next;
  }

  async #load(): Promise<Readonly<Record<string, string>>> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
}
