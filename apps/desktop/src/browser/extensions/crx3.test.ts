import { zipSync } from "fflate";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHROME_WEB_STORE_PUBLISHER_KEY_HASHES,
  extensionIdFromPublicKey,
  parseAndVerifyCrx3,
  unpackCrx3,
} from "./crx3.js";
import {
  discoverStoreExtensions,
  resolveOmahaPackageUrl,
  resolveVerifiedManifestName,
  writeStoreLedger,
} from "./web-store.js";

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const length = encodeVarint(payload.length);
  return Buffer.concat([tag, length, payload]);
}

function buildCrx3(
  files: Record<string, string | Uint8Array>,
  tamper?: "signature" | "archive" | "version2",
  options?: { readonly includePublisherProof?: boolean },
) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const crxIdBytes = createHash("sha256").update(spki).digest().subarray(0, 16);
  const extensionId = extensionIdFromPublicKey(spki);

  const zipInput: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) {
    zipInput[name] = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  }
  const archive = Buffer.from(zipSync(zipInput));

  const signedHeaderData = encodeLengthDelimited(1, crxIdBytes);
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(signedHeaderData.length, 0);
  const signedPayload = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "binary"),
    lengthPrefix,
    signedHeaderData,
    archive,
  ]);
  const signature = Buffer.from(sign("sha256", signedPayload, privateKey));
  if (tamper === "signature") signature[0] = (signature[0]! ^ 0xff) & 0xff;

  const proof = Buffer.concat([
    encodeLengthDelimited(1, spki),
    encodeLengthDelimited(2, signature),
  ]);
  const headerParts: Buffer[] = [encodeLengthDelimited(2, proof)];

  let publisherKeyHash: string | null = null;
  if (options?.includePublisherProof) {
    const pubPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pubSpki = pubPair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const pubSig = Buffer.from(sign("sha256", signedPayload, pubPair.privateKey));
    publisherKeyHash = createHash("sha256").update(pubSpki).digest("hex");
    const pubProof = Buffer.concat([
      encodeLengthDelimited(1, pubSpki),
      encodeLengthDelimited(2, pubSig),
    ]);
    headerParts.push(encodeLengthDelimited(3, pubProof));
  }

  headerParts.push(encodeLengthDelimited(10_000, signedHeaderData));
  const header = Buffer.concat(headerParts);

  const finalArchive = Buffer.from(archive);
  if (tamper === "archive" && finalArchive.length > 0) {
    finalArchive[finalArchive.length - 1] = (finalArchive[finalArchive.length - 1]! ^ 0xff) & 0xff;
  }

  const preamble = Buffer.alloc(12);
  preamble.write("Cr24", 0, "ascii");
  preamble.writeUInt32LE(tamper === "version2" ? 2 : 3, 4);
  preamble.writeUInt32LE(header.length, 8);

  return {
    extensionId,
    spki,
    publisherKeyHash,
    crx: Buffer.concat([preamble, header, finalArchive]),
  };
}

describe("CRX3 verification and safe unpacking", () => {
  it("verifies a validly signed CRX3 package, unpacks it, writes manifest.key, and excludes Chrome Web Store content scripts", async () => {
    const built = buildCrx3({
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        name: "Signed",
        version: "1.2.0",
        content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
      }),
      "worker.js": "console.log('ok');",
      "content.js": "console.log('cs');",
    });
    const parsed = parseAndVerifyCrx3(built.crx, built.extensionId);
    expect(parsed.extensionId).toBe(built.extensionId);

    const dir = await mkdtemp(path.join(os.tmpdir(), "opensteer-crx3-test-"));
    try {
      const manifest = await unpackCrx3(parsed, dir);
      expect(manifest.version).toBe("1.2.0");
      expect(manifest.key).toBe(built.spki.toString("base64"));
      const onDisk = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
      expect(onDisk.key).toBe(built.spki.toString("base64"));
      expect(onDisk.content_scripts[0].exclude_matches).toEqual([
        "*://chromewebstore.google.com/*",
        "*://chrome.google.com/webstore*",
      ]);
      expect(await readFile(path.join(dir, "worker.js"), "utf8")).toBe("console.log('ok');");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects CRX2, invalid signatures, tampered archives, and mismatched extension IDs", () => {
    const v2 = buildCrx3({ "manifest.json": "{}" }, "version2");
    expect(() => parseAndVerifyCrx3(v2.crx)).toThrow(/CRX3/u);

    const badSig = buildCrx3({ "manifest.json": "{}" }, "signature");
    expect(() => parseAndVerifyCrx3(badSig.crx)).toThrow(/signature/u);

    const badArchive = buildCrx3({ "manifest.json": "{}" }, "archive");
    expect(() => parseAndVerifyCrx3(badArchive.crx)).toThrow(/signature/u);

    const valid = buildCrx3({ "manifest.json": "{}" });
    expect(() => parseAndVerifyCrx3(valid.crx, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(
      /mismatch/u,
    );
  });

  it("rejects zip-slip traversal paths during unpack", async () => {
    const built = buildCrx3({
      "manifest.json": JSON.stringify({ manifest_version: 3, name: "Evil", version: "1.0.0" }),
      "../escape.txt": "pwned",
    });
    const parsed = parseAndVerifyCrx3(built.crx, built.extensionId);
    const dir = await mkdtemp(path.join(os.tmpdir(), "opensteer-crx3-slip-"));
    try {
      await expect(unpackCrx3(parsed, dir)).rejects.toThrow(/unsafe entry path/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces required publisher key proofs alongside the developer signature", () => {
    const withPub = buildCrx3(
      { "manifest.json": JSON.stringify({ manifest_version: 3, name: "Store", version: "1.0.0" }) },
      undefined,
      { includePublisherProof: true },
    );
    expect(withPub.publisherKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      parseAndVerifyCrx3(withPub.crx, withPub.extensionId, {
        requiredKeyHashes: new Set([withPub.publisherKeyHash!]),
      }).extensionId,
    ).toBe(withPub.extensionId);

    expect(() =>
      parseAndVerifyCrx3(withPub.crx, withPub.extensionId, {
        requiredKeyHashes: CHROME_WEB_STORE_PUBLISHER_KEY_HASHES,
      }),
    ).toThrow(/publisher key proof/u);
  });

  it("resolves Omaha 3.1 codebase + package name and rejects non-HTTPS", () => {
    expect(
      resolveOmahaPackageUrl(
        "https://clients2.googleusercontent.com/crx/blobs/abc123",
        "extension_1_2_0.crx",
      ),
    ).toBe("https://clients2.googleusercontent.com/crx/blobs/abc123/extension_1_2_0.crx");
    expect(
      resolveOmahaPackageUrl(
        "https://clients2.googleusercontent.com/crx/blobs/abc123/extension_1_2_0.crx",
        "extension_1_2_0.crx",
      ),
    ).toBe("https://clients2.googleusercontent.com/crx/blobs/abc123/extension_1_2_0.crx");
    expect(resolveOmahaPackageUrl("http://example.com/crx/", "a.crx")).toBeNull();
  });

  it("discovers only the ledger-committed Store version and ignores uncommitted newer dirs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opensteer-store-ledger-"));
    try {
      const id = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
      const committed = path.join(root, id, "1.0.0_0");
      const failedNewer = path.join(root, id, "2.0.0_0");
      await mkdir(committed, { recursive: true });
      await mkdir(failedNewer, { recursive: true });
      await writeFile(
        path.join(committed, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "Committed", version: "1.0.0", key: "k" }),
      );
      await writeFile(
        path.join(failedNewer, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "Failed", version: "2.0.0", key: "k" }),
      );
      await writeStoreLedger(root, { [id]: { version: "1.0.0", dirName: "1.0.0_0" } });

      const discovered = await discoverStoreExtensions(root);
      expect(discovered).toEqual([{ id, version: "1.0.0", path: committed }]);

      // Corrupt store.json fails closed rather than falling back to the legacy directory scan.
      await writeFile(path.join(root, "store.json"), "{ not-valid-json", { mode: 0o600 });
      expect(await discoverStoreExtensions(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves __MSG_ names strictly from the verified unpacked locale bundle", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opensteer-msg-name-"));
    try {
      await mkdir(path.join(dir, "_locales", "en"), { recursive: true });
      await writeFile(
        path.join(dir, "_locales", "en", "messages.json"),
        JSON.stringify({ extension_name: { message: "Dark Reader Verified" } }),
      );
      expect(
        await resolveVerifiedManifestName(
          dir,
          { name: "__MSG_EXTENSION_NAME__", default_locale: "en" },
          "eimadpbcbfnmbkopoojfekhnkhdbieeh",
        ),
      ).toBe("Dark Reader Verified");
      expect(
        await resolveVerifiedManifestName(
          dir,
          { name: "__MSG_MISSING__", default_locale: "en" },
          "eimadpbcbfnmbkopoojfekhnkhdbieeh",
        ),
      ).toBe("eimadpbcbfnmbkopoojfekhnkhdbieeh");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
