import { LocalProfileBindingSchema } from "@opensteer/protocol";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BrowserAttachTicketClaims,
  BrowserPreparationTicketClaims,
} from "@opensteer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntimeError } from "../errors.js";
import { validClaims } from "../test-support/fakes.js";
import {
  Ed25519AttachTicketVerifier,
  type Ed25519AttachTicketVerifierOptions,
} from "./attach-ticket.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Ed25519AttachTicketVerifier", () => {
  it("rejects preparation tickets at attach and shares durable replay protection", async () => {
    const keys = generateKeyPairSync("ed25519");
    const { verifier } = await createVerifier({ resolvePublicKey: () => keys.publicKey });
    const c = validClaims();
    const identity = {
      kind: "profile-local" as const,
      binding: LocalProfileBindingSchema.parse({
        version: 1,
        engine: "chromium",
        deploymentId: "dep_11111111-1111-4111-8111-111111111111",
        profileId: "bpr_11111111-1111-4111-8111-111111111111",
        runnerId: "rnr_11111111-1111-4111-8111-111111111111",
        storageInstanceId: "11111111-1111-4111-8111-111111111111",
        bindingId: "11111111-1111-4111-8111-111111111111",
      }),
    };
    const signed = ticket(
      {
        audience: c.audience,
        purpose: "profile-prepare",
        identity,
        runtimeId: c.runtimeId,
        subject: c.subject,
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
        nonce: c.nonce,
      },
      keys.privateKey,
      { alg: "EdDSA", kid: "host-key-1", typ: "opensteer-browser-prepare+jwt" },
    );
    await expect(verifier.verify(signed, expectation())).rejects.toThrow(/header/);
    await expect(verifier.verifyPreparation(signed, expectation())).resolves.toMatchObject({
      purpose: "profile-prepare",
      identity,
    });
    await expect(verifier.verifyPreparation(signed, expectation())).rejects.toThrow(
      /already been used/,
    );
    await expect(
      verifier.verifyPreparation(ticket(c, keys.privateKey), expectation()),
    ).rejects.toThrow(/header/);
  });
  it("verifies Host-signed claims for the expected runtime", async () => {
    const keys = generateKeyPairSync("ed25519");
    const { verifier } = await createVerifier({
      resolvePublicKey: (keyId) => (keyId === "host-key-1" ? keys.publicKey : null),
    });
    const claims = validClaims();

    await expect(verifier.verify(ticket(claims, keys.privateKey), expectation())).resolves.toEqual(
      claims,
    );
  });

  it.each([
    ["wrong runtime", { runtimeId: "runtime_other" }],
    ["future issue time", { issuedAt: "2030-01-01T00:02:00.000Z" }],
    ["expired ticket", { expiresAt: "2030-01-01T00:00:30.000Z" }],
    ["excessive lifetime", { expiresAt: "2030-01-01T00:30:00.000Z" }],
  ])("rejects %s", async (_label, overrides) => {
    const keys = generateKeyPairSync("ed25519");
    const { verifier } = await createVerifier({ resolvePublicKey: () => keys.publicKey });
    const claims = validClaims(overrides as Partial<BrowserAttachTicketClaims>);

    await expect(
      verifier.verify(ticket(claims, keys.privateKey), expectation()),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects signature tampering and unknown keys without consuming the nonce", async () => {
    const signer = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const claims = validClaims();
    const signed = ticket(claims, signer.privateKey);
    const tampered = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`;
    const ledgerPath = await temporaryLedgerPath();

    const wrongKey = await Ed25519AttachTicketVerifier.create({
      replayLedgerPath: ledgerPath,
      resolvePublicKey: () => other.publicKey,
    });
    await expect(wrongKey.verify(tampered, expectation())).rejects.toBeInstanceOf(
      BrowserRuntimeError,
    );

    const unknownKey = await Ed25519AttachTicketVerifier.create({
      replayLedgerPath: ledgerPath,
      resolvePublicKey: () => null,
    });
    await expect(unknownKey.verify(signed, expectation())).rejects.toMatchObject({
      code: "forbidden",
    });

    const valid = await Ed25519AttachTicketVerifier.create({
      replayLedgerPath: ledgerPath,
      resolvePublicKey: () => signer.publicKey,
    });
    await expect(valid.verify(signed, expectation())).resolves.toEqual(claims);
  });

  it("persists a consumed nonce across verifier and Runtime restarts", async () => {
    const keys = generateKeyPairSync("ed25519");
    const replayLedgerPath = await temporaryLedgerPath();
    const claims = validClaims();
    const signed = ticket(claims, keys.privateKey);
    const first = await Ed25519AttachTicketVerifier.create({
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });

    await first.verify(signed, expectation());

    const restarted = await Ed25519AttachTicketVerifier.create({
      initializationNow: expectation().now,
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    await expect(restarted.verify(signed, expectation())).rejects.toMatchObject({
      code: "forbidden",
      message: "The browser attach ticket has already been used.",
    });
  });

  it("serializes concurrent claims so exactly one verification accepts a nonce", async () => {
    const keys = generateKeyPairSync("ed25519");
    const { verifier } = await createVerifier({ resolvePublicKey: () => keys.publicKey });
    const signed = ticket(validClaims(), keys.privateKey);

    const outcomes = await Promise.allSettled([
      verifier.verify(signed, expectation()),
      verifier.verify(signed, expectation()),
      verifier.verify(signed, expectation()),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(2);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({
          code: "forbidden",
          message: "The browser attach ticket has already been used.",
        });
      }
    }
  });

  it("serializes concurrent claims from two verifiers sharing one process and path", async () => {
    const keys = generateKeyPairSync("ed25519");
    const replayLedgerPath = await temporaryLedgerPath();
    const [first, second] = await Promise.all([
      Ed25519AttachTicketVerifier.create({
        replayLedgerPath,
        resolvePublicKey: () => keys.publicKey,
      }),
      Ed25519AttachTicketVerifier.create({
        replayLedgerPath,
        resolvePublicKey: () => keys.publicKey,
      }),
    ]);
    const signed = ticket(validClaims(), keys.privateKey);

    const outcomes = await Promise.allSettled([
      first.verify(signed, expectation()),
      second.verify(signed, expectation()),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({
      code: "forbidden",
      message: "The browser attach ticket has already been used.",
    });
  });

  it("never evicts a valid nonce when the item bound is full", async () => {
    const keys = generateKeyPairSync("ed25519");
    const { verifier } = await createVerifier({
      maxReplayEntries: 1,
      resolvePublicKey: () => keys.publicKey,
    });
    const first = validClaims();
    const second = validClaims({ nonce: "nonce_fedcba9876543210" });

    await verifier.verify(ticket(first, keys.privateKey), expectation());
    await expect(
      verifier.verify(ticket(second, keys.privateKey), expectation()),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "The browser attach ticket replay ledger is full.",
    });
    await expect(
      verifier.verify(ticket(first, keys.privateKey), expectation()),
    ).rejects.toMatchObject({
      message: "The browser attach ticket has already been used.",
    });
  });

  it("prunes expired entries durably before admitting another nonce", async () => {
    const keys = generateKeyPairSync("ed25519");
    const replayLedgerPath = await temporaryLedgerPath();
    const first = await Ed25519AttachTicketVerifier.create({
      maxReplayEntries: 1,
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    await first.verify(ticket(validClaims(), keys.privateKey), expectation());

    const restarted = await Ed25519AttachTicketVerifier.create({
      initializationNow: new Date("2030-01-01T00:06:00.000Z"),
      maxReplayEntries: 1,
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    const next = validClaims({
      expiresAt: "2030-01-01T00:09:00.000Z",
      issuedAt: "2030-01-01T00:05:30.000Z",
      nonce: "nonce_fedcba9876543210",
    });
    await expect(
      restarted.verify(ticket(next, keys.privateKey), expectation("2030-01-01T00:06:00.000Z")),
    ).resolves.toEqual(next);

    const persisted = JSON.parse(await readFile(replayLedgerPath, "utf8")) as {
      entries: Array<{ nonce: string }>;
    };
    expect(persisted.entries.map((entry) => entry.nonce)).toEqual([next.nonce]);
  });

  it("fails closed when the wall clock rolls behind its persisted high-water mark", async () => {
    const keys = generateKeyPairSync("ed25519");
    const replayLedgerPath = await temporaryLedgerPath();
    const first = await Ed25519AttachTicketVerifier.create({
      initializationNow: expectation().now,
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    await first.verify(ticket(validClaims(), keys.privateKey), expectation());

    await Ed25519AttachTicketVerifier.create({
      initializationNow: new Date("2030-01-01T00:06:00.000Z"),
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    await expect(
      Ed25519AttachTicketVerifier.create({
        initializationNow: new Date("2030-01-01T00:02:00.000Z"),
        replayLedgerPath,
        resolvePublicKey: () => keys.publicKey,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "The browser attach ticket replay ledger is unavailable.",
    });
  });

  it("fails closed on corrupt or oversized durable state", async () => {
    const keys = generateKeyPairSync("ed25519");
    const replayLedgerPath = await temporaryLedgerPath();
    const verifier = await Ed25519AttachTicketVerifier.create({
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    await writeFile(replayLedgerPath, "{not-json", { mode: 0o600 });

    await expect(
      verifier.verify(ticket(validClaims(), keys.privateKey), expectation()),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "The browser attach ticket replay ledger is unavailable.",
    });
    await expect(
      Ed25519AttachTicketVerifier.create({
        maxReplayFileBytes: 128,
        replayLedgerPath,
        resolvePublicKey: () => keys.publicKey,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await writeFile(replayLedgerPath, Buffer.alloc(129, 0x20), { mode: 0o600 });
    await expect(
      Ed25519AttachTicketVerifier.create({
        maxReplayFileBytes: 128,
        replayLedgerPath,
        resolvePublicKey: () => keys.publicKey,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("fails startup when an initialized Runtime ledger is missing", async () => {
    const keys = generateKeyPairSync("ed25519");
    const replayLedgerPath = await temporaryLedgerPath();
    await Ed25519AttachTicketVerifier.create({
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    await rm(replayLedgerPath);

    await expect(
      Ed25519AttachTicketVerifier.create({
        replayLedgerPath,
        resolvePublicKey: () => keys.publicKey,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "The browser attach ticket replay ledger is unavailable.",
    });
  });

  it("rejects a claim that would exceed the ledger byte bound without corrupting state", async () => {
    const keys = generateKeyPairSync("ed25519");
    const { replayLedgerPath, verifier } = await createVerifier({
      maxReplayFileBytes: 80,
      resolvePublicKey: () => keys.publicKey,
    });

    await expect(
      verifier.verify(ticket(validClaims(), keys.privateKey), expectation()),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "The browser attach ticket replay ledger is full.",
    });
    expect(JSON.parse(await readFile(replayLedgerPath, "utf8"))).toEqual({
      entries: [],
      highWaterAt: expect.any(Number),
      version: 1,
    });
  });

  it("creates and repairs private ledger modes and fails closed on storage errors", async () => {
    const keys = generateKeyPairSync("ed25519");
    const replayLedgerPath = await temporaryLedgerPath();
    await Ed25519AttachTicketVerifier.create({
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    const directory = path.dirname(replayLedgerPath);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(replayLedgerPath)).mode & 0o777).toBe(0o600);

    await chmod(directory, 0o777);
    await chmod(replayLedgerPath, 0o666);
    await Ed25519AttachTicketVerifier.create({
      replayLedgerPath,
      resolvePublicKey: () => keys.publicKey,
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(replayLedgerPath)).mode & 0o777).toBe(0o600);

    const root = await temporaryDirectory();
    const blockingFile = path.join(root, "not-a-directory");
    await writeFile(blockingFile, "blocked", { mode: 0o600 });
    await expect(
      Ed25519AttachTicketVerifier.create({
        replayLedgerPath: path.join(blockingFile, "ledger.json"),
        resolvePublicKey: () => keys.publicKey,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "The browser attach ticket replay ledger is unavailable.",
    });
  });

  it("rejects algorithm substitution before signature verification", async () => {
    const keys = generateKeyPairSync("ed25519");
    const claims = validClaims();
    const forged = ticket(claims, keys.privateKey, { alg: "none" });
    const { verifier } = await createVerifier({ resolvePublicKey: () => keys.publicKey });

    await expect(verifier.verify(forged, expectation())).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

async function createVerifier(
  options: Omit<Ed25519AttachTicketVerifierOptions, "replayLedgerPath">,
): Promise<{ replayLedgerPath: string; verifier: Ed25519AttachTicketVerifier }> {
  const replayLedgerPath = await temporaryLedgerPath();
  return {
    replayLedgerPath,
    verifier: await Ed25519AttachTicketVerifier.create({ ...options, replayLedgerPath }),
  };
}

function expectation(now = "2030-01-01T00:01:00.000Z") {
  return { now: new Date(now), runtimeId: "runtime_test" } as const;
}

async function temporaryLedgerPath(): Promise<string> {
  return path.join(await temporaryDirectory(), "private", "attach-ticket-replay-v1.json");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-browser-replay-"));
  temporaryDirectories.push(directory);
  return directory;
}

function ticket(
  claims: BrowserAttachTicketClaims | BrowserPreparationTicketClaims,
  privateKey: KeyObject,
  header: Record<string, unknown> = {
    alg: "EdDSA",
    kid: "host-key-1",
    typ: "opensteer-browser-attach+jwt",
  },
): string {
  const protectedSegment = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadSegment = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`${protectedSegment}.${payloadSegment}`, "ascii"),
    privateKey,
  ).toString("base64url");
  return `${protectedSegment}.${payloadSegment}.${signature}`;
}
