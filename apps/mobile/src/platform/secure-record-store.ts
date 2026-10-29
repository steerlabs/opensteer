import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { z } from "zod";

/**
 * Records of arbitrary length in a key-value store that only holds short
 * strings.
 *
 * The Keychain and the Keystore are reached through `expo-secure-store`, which
 * documents a 2048-byte ceiling per value and no way to list what it holds. An
 * OAuth credential record is usually well under that and is allowed by its
 * schema to be far over it, so a record is written as a bounded run of chunks
 * under derived names and a manifest that says where they are. A record that
 * would need more chunks than the bound is refused by name — never truncated,
 * because half a refresh token reads back as a corrupt credential rather than
 * as a missing one.
 *
 * Each rewrite puts its chunks under a fresh generation and commits the
 * manifest last, so no write ever overwrites a chunk a reader could still
 * follow. A reader follows the manifest and nothing else: until the manifest
 * names the new generation the record is the old one, whole, and afterwards it
 * is the new one, whole. There is no instant at which the two are mixed.
 *
 * Two things make that hold under the conditions a phone actually meets. Every
 * operation on one record runs alone, through a queue held per record name, so
 * two writes can never read the same manifest and pick the same generation and
 * interleave their chunks into a value that was neither of them. And a
 * generation is announced in the manifest *before* its chunks are written, so
 * chunks the operating system interrupted are named on the device rather than
 * inferred: whatever operation touches the record next collects them. The
 * counter the generation comes from only ever increases, so no run of chunks is
 * ever written under a name an older, half-finished run may still occupy.
 */

/** `expo-secure-store`, as this module needs it. */
export interface SecureStoreLike {
  deleteItemAsync(key: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  isAvailableAsync(): Promise<boolean>;
  setItemAsync(key: string, value: string): Promise<void>;
}

/** The documented per-value ceiling, in UTF-8 bytes. */
export const maxSecureStoreValueBytes = 2_048;

/**
 * Enough for any credential a person actually holds, with room for the 64KB
 * tokens the schema permits, and small enough that a runaway value is reported
 * rather than written across hundreds of Keychain items.
 */
export const maxRecordChunks = 96;

const generationNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const GenerationSchema = z.strictObject({
  chunks: z.number().int().min(1).max(maxRecordChunks),
  generation: generationNumber,
});
type Generation = z.infer<typeof GenerationSchema>;

/**
 * Where this record's value is, which generations may still have chunks nobody
 * follows, and the next generation number that may be handed out.
 *
 * `current` is null between the moment a record is first announced and the
 * moment its first value commits, and again while a removal is in progress:
 * both are states where the honest answer to a reader is that there is no
 * record. `incomplete` is at most two entries — the generation being written
 * and the one it supersedes — but is bounded generously so a manifest written
 * by a release that tracked more still loads.
 */
const ManifestSchema = z.strictObject({
  current: GenerationSchema.nullable(),
  incomplete: z.array(GenerationSchema).max(8),
  next: generationNumber,
});
type Manifest = z.infer<typeof ManifestSchema>;

export interface SecureRecordStore {
  assertAvailable(): Promise<void>;
  read(name: string): Promise<string | null>;
  remove(name: string): Promise<void>;
  write(name: string, value: string): Promise<void>;
}

export function createSecureRecordStore(options: {
  readonly keyPrefix: string;
  readonly secureStore: SecureStoreLike;
}): SecureRecordStore {
  const { keyPrefix, secureStore } = options;
  const manifestKey = (name: string) => `${keyPrefix}.${name}`;
  const chunkKey = (name: string, generation: number, index: number) =>
    `${keyPrefix}.${name}.g${generation}.${index}`;

  /**
   * One queue per record name. A record is the unit of atomicity here — two
   * records share nothing but the store — so serializing across records would
   * make every credential write wait behind every other one for no gain. The
   * map is keyed by record name and is bounded by the number of Deployments
   * this phone holds.
   */
  const queues = new Map<string, MutationQueue>();
  const serialize = <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    let queue = queues.get(name);
    if (queue === undefined) {
      queue = new MutationQueue();
      queues.set(name, queue);
    }
    return queue.run(operation);
  };

  const emptyManifest = (): Manifest => ({ current: null, incomplete: [], next: 0 });

  const readManifest = async (name: string): Promise<Manifest | null> => {
    const stored = await secureStore.getItemAsync(manifestKey(name));
    if (stored === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(stored);
    } catch {
      throw new Error("A stored credential record on this device is unreadable.");
    }
    const parsed = ManifestSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error("A stored credential record on this device is unreadable.");
    }
    return parsed.data;
  };

  const writeManifest = async (name: string, manifest: Manifest): Promise<Manifest> => {
    const parsed = ManifestSchema.parse(manifest);
    await secureStore.setItemAsync(manifestKey(name), JSON.stringify(parsed));
    return parsed;
  };

  const deleteChunks = async (name: string, generation: Generation): Promise<void> => {
    for (let index = 0; index < generation.chunks; index += 1) {
      await secureStore.deleteItemAsync(chunkKey(name, generation.generation, index));
    }
  };

  /**
   * Deletes every generation the manifest says nobody follows, then stops
   * saying so. Interrupting either half is safe: the chunks are named until the
   * manifest that names them is replaced, so the next operation finishes it.
   */
  const collect = async (name: string, manifest: Manifest): Promise<Manifest> => {
    if (manifest.incomplete.length === 0) return manifest;
    for (const generation of manifest.incomplete) await deleteChunks(name, generation);
    return writeManifest(name, { ...manifest, incomplete: [] });
  };

  const readRecord = async (name: string): Promise<string | null> => {
    const manifest = await readManifest(name);
    if (manifest === null || manifest.current === null) return null;
    let value = "";
    for (let index = 0; index < manifest.current.chunks; index += 1) {
      const chunk = await secureStore.getItemAsync(
        chunkKey(name, manifest.current.generation, index),
      );
      // A manifest without its chunks is a partially cleared record, which is
      // a fault: reporting it keeps a half-written credential from being
      // presented as a complete one.
      if (chunk === null) {
        throw new Error("A stored credential record on this device is incomplete.");
      }
      value += chunk;
    }
    return value;
  };

  return {
    async assertAvailable(): Promise<void> {
      if (!(await secureStore.isAvailableAsync())) {
        throw new Error("This device's protected credential storage is unavailable.");
      }
    },

    read: (name) => serialize(name, () => readRecord(name)),

    remove: (name) =>
      serialize(name, async () => {
        const stored = await readManifest(name);
        if (stored === null) return;
        // The record stops existing for a reader here, before a single chunk
        // goes: an interrupted removal must leave nothing that reads as present
        // and comes back short.
        const emptied = await writeManifest(name, {
          current: null,
          incomplete: [...stored.incomplete, ...(stored.current === null ? [] : [stored.current])],
          next: stored.next,
        });
        await collect(name, emptied);
        // Last, and only once every chunk it accounted for is gone: the
        // manifest is what keeps generation numbers from being handed out
        // twice, so it outlives the value it described.
        await secureStore.deleteItemAsync(manifestKey(name));
      }),

    write: (name, value) =>
      serialize(name, async () => {
        const chunks = splitIntoSecureStoreChunks(value);
        if (chunks.length > maxRecordChunks) {
          throw new Error("This credential is too large for protected storage on this device.");
        }
        const stored = (await readManifest(name)) ?? emptyManifest();
        // Whatever an earlier interrupted operation left behind goes first. A
        // generation is never reused, so this can only remove chunks no reader
        // could follow.
        const manifest = await collect(name, stored);
        if (manifest.next >= Number.MAX_SAFE_INTEGER) {
          throw new Error("This credential has been rewritten too many times on this device.");
        }
        const generation: Generation = { chunks: chunks.length, generation: manifest.next };
        // Announced before it is written. From here the chunks about to be laid
        // down have a name on the device, so a process that dies half way
        // through them is cleaned up by whatever touches this record next
        // rather than leaving orphans no manifest ever mentions.
        const announced = await writeManifest(name, {
          ...manifest,
          incomplete: [generation],
          next: generation.generation + 1,
        });
        for (const [index, chunk] of chunks.entries()) {
          await secureStore.setItemAsync(chunkKey(name, generation.generation, index), chunk);
        }
        // The commit. Before this line a reader follows the old generation,
        // whose chunks are untouched; after it, the new one, which is complete.
        const committed = await writeManifest(name, {
          current: generation,
          incomplete: announced.current === null ? [] : [announced.current],
          next: announced.next,
        });
        await collect(name, committed);
      }),
  };
}

/**
 * Cuts a string into pieces no larger than the ceiling in UTF-8 bytes, never
 * between the two halves of a surrogate pair. An empty value is one empty
 * chunk, so the round trip preserves it.
 */
export function splitIntoSecureStoreChunks(value: string): readonly string[] {
  if (value === "") return [""];
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = start;
    let bytes = 0;
    while (end < value.length) {
      const codePoint = value.codePointAt(end);
      if (codePoint === undefined) break;
      const width = codePoint > 0xffff ? 2 : 1;
      const size = encoder.encode(value.slice(end, end + width)).byteLength;
      if (bytes + size > maxSecureStoreValueBytes) break;
      bytes += size;
      end += width;
    }
    // A single code point can never exceed the ceiling, so `end` always moves.
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}
