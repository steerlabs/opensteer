import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createDocumentPrivateFilesystem } from "../src/platform/private-filesystem.js";
import { MemorySecureStore } from "../src/platform/memory-secure-store.js";
import {
  createSavedHostViewStore,
  type SavedViewCrypto,
} from "../src/platform/saved-host-view-store.js";

export const savedViewTestCrypto: SavedViewCrypto = {
  generateKey: async () => randomBytes(32).toString("base64"),
  async encrypt(key, plaintext, aad) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
    cipher.setAAD(aad);
    return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  },
  async decrypt(key, sealed, aad) {
    const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), sealed.slice(0, 12));
    cipher.setAAD(aad);
    cipher.setAuthTag(sealed.slice(-16));
    return Buffer.concat([cipher.update(sealed.slice(12, -16)), cipher.final()]);
  },
};
export function savedViewFixture(cleanup: (() => void)[]) {
  const sandbox = mkdtempSync(`${tmpdir()}/saved-views-`);
  const directory = `${sandbox}/views`;
  mkdirSync(directory);
  cleanup.push(() => rmSync(sandbox, { recursive: true, force: true }));
  const filesystemRoot = `${pathToFileURL(sandbox).href}/`;
  const root = `${pathToFileURL(directory).href}/`;
  let interrupt = (_step: string) => {};
  const files = createDocumentPrivateFilesystem({
    root: filesystemRoot,
    directory: (uri) => ({
      uri,
      get exists() {
        return existsSync(fileURLToPath(uri));
      },
      create: () => mkdirSync(fileURLToPath(uri), { recursive: true }),
      list: () => readdirSync(fileURLToPath(uri)),
    }),
    file: (uri) => ({
      uri,
      get exists() {
        return existsSync(fileURLToPath(uri));
      },
      bytes: async () => readFileSync(fileURLToPath(uri)),
      create: () => {
        interrupt(`create:${uri}`);
        writeFileSync(fileURLToPath(uri), "");
      },
      writeSync: (bytes) => {
        interrupt(`write:${uri}`);
        writeFileSync(fileURLToPath(uri), bytes);
      },
      delete: () => {
        interrupt(`delete:${uri}`);
        rmSync(fileURLToPath(uri));
      },
    }),
    replace: (from, to) => {
      interrupt(`move:${from}`);
      renameSync(fileURLToPath(from), fileURLToPath(to));
    },
  });
  const keys = new MemorySecureStore();
  const list = () =>
    readdirSync(directory).map((name) => ({
      name,
      modifiedAt: statSync(`${directory}/${name}`).mtimeMs,
    }));
  const open = () =>
    createSavedHostViewStore({
      files,
      directory: root.slice(0, -1),
      list,
      keys,
      keyPrefix: "saved",
      crypto: savedViewTestCrypto,
    });
  return {
    directory,
    root,
    files,
    keys,
    list,
    open,
    interrupt: (fn: typeof interrupt) => {
      interrupt = fn;
    },
  };
}
