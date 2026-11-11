import type { IpcMain, IpcMainEvent, WebContents } from "electron";
import { z } from "zod";

const sessionStorageSchema = z.object({
  origin: z.url().refine((value) => new URL(value).origin === value && value !== "null"),
  items: z.array(z.tuple([z.string(), z.string()])),
});
export const ElectronPageRestoreSchema = z
  .object({
    entries: z
      .array(z.object({ url: z.string(), title: z.string(), pageState: z.string().optional() }))
      .min(1),
    index: z.number().int().nonnegative(),
    sessionStorage: sessionStorageSchema.nullable(),
  })
  .refine((value) => value.index < value.entries.length);
export type ElectronPageRestore = z.infer<typeof ElectronPageRestoreSchema>;
type StorageSeed = z.infer<typeof sessionStorageSchema>;

export function boundPageRestore(input: ElectronPageRestore): ElectronPageRestore | null {
  const state = ElectronPageRestoreSchema.parse(input);
  if (
    state.sessionStorage &&
    Buffer.byteLength(JSON.stringify(state.sessionStorage.items)) > 256 * 1024
  )
    return null;
  const distant = state.entries
    .map((_, index) => index)
    .sort((a, b) => Math.abs(b - state.index) - Math.abs(a - state.index));
  let bytes = Buffer.byteLength(JSON.stringify(state));
  for (const index of distant) {
    if (bytes <= 1024 ** 2) return state;
    const entry = state.entries[index]!;
    if (entry.pageState !== undefined) {
      bytes -= Buffer.byteLength(JSON.stringify(entry));
      delete entry.pageState;
      bytes += Buffer.byteLength(JSON.stringify(entry));
    }
  }
  return bytes <= 1024 ** 2 ? state : null;
}

export class WakeSeeds {
  readonly #seeds = new Map<number, StorageSeed>();
  readonly #ipc: Pick<IpcMain, "on" | "off">;
  readonly #answer = (event: IpcMainEvent) => {
    const seed = this.#seeds.get(event.sender.id);
    this.#seeds.delete(event.sender.id);
    let ok = false;
    try {
      ok =
        !!seed &&
        !!event.senderFrame &&
        event.senderFrame === event.sender.mainFrame &&
        new URL(event.senderFrame.url).origin === seed.origin;
    } catch {
      /* A detached frame has no origin. */
    }
    event.returnValue = ok ? seed!.items : null;
  };
  constructor(ipc: Pick<IpcMain, "on" | "off">) {
    this.#ipc = ipc;
    ipc.on("opensteer:wake-seed", this.#answer);
  }
  offer(contents: WebContents, seed: StorageSeed | null): void {
    if (!seed) return;
    this.#seeds.set(contents.id, seed);
    contents.once("destroyed", () => this.#seeds.delete(contents.id));
  }
  close(): void {
    this.#ipc.off("opensteer:wake-seed", this.#answer);
    this.#seeds.clear();
  }
}

export function seedSessionStorage(items: readonly (readonly [string, string])[]): void {
  for (const [key, value] of items) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* Storage can be denied. */
    }
  }
}
