import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean)
  // The index still names files deleted in the working tree, and a file that is
  // gone declares nothing, so the guard reads what is actually on disk.
  .filter((file) => existsSync(path.join(repositoryRoot, file)));

const sources = new Map(
  sourceFiles.map((file) => [file, readFileSync(path.join(repositoryRoot, file), "utf8")]),
);

/**
 * Every entry is the one file allowed to define that helper. A list means the
 * extra homes are deliberate and each is justified below; a list is never a
 * way to make a stray copy pass.
 */
const helperHomes: Readonly<Record<string, string | readonly string[]>> = {
  freePort: "packages/shared/src/loopbackPort.test-support.ts",
  assertRegularFile: "packages/shared/src/privateFiles.ts",
  /**
   * The rule that a client never chooses a native model id. The mock host
   * client mirrors it because a mock cannot import from an app, and this pin
   * is what keeps the two copies from drifting apart unnoticed.
   */
  storedModelSelection: [
    "apps/host/src/agents/model-selection.ts",
    "packages/client/src/mock/mock-host-client.ts",
  ],
  /**
   * The broker copy is frozen crypto: it produces the sealed plaintext and the
   * HKDF/AES-GCM additional authenticated data, so it must never move to a
   * helper that can evolve underneath already-sealed payloads.
   */
  canonicalJson: [
    "packages/integration-auth/src/broker-sealing.ts",
    "packages/shared/src/canonicalJson.ts",
  ],
  /**
   * Five engine drivers all bound a denial note the same way, and one of them
   * bounded UTF-16 units instead of bytes — four times the agreed payload.
   * One home, one unit.
   */
  boundedDenialNote: "packages/harness/src/denial-note.ts",
  clampConnectionLabel: "packages/harness/src/labels.ts",
  /**
   * A server's terminal HTTP disposal: the listener first, then every
   * connection. The order and the refusal below are what keep a stopping
   * server from waiting on its peers.
   */
  closeHttpServerNow: "packages/shared/src/httpServer.ts",
  ignoreForeignTestRequest: "packages/shared/src/serverProbes.test-support.ts",
  probeTestServer: "packages/shared/src/serverProbes.test-support.ts",
  resetTestServer: "packages/shared/src/serverProbes.test-support.ts",
  observeTestConnection: "packages/shared/src/serverProbes.test-support.ts",
  settleTestConnections: "packages/shared/src/serverProbes.test-support.ts",
  startEchoTestServer: "packages/shared/src/tcpServer.test-support.ts",
  collectStreamText: "packages/harness/src/process-supervisor.ts",
  compareSequence: "packages/core/src/ids.ts",
  /**
   * What a reader calls a conversation, and whom a message is from. The web
   * once renamed Chat on its own while mobile kept it; every client reads
   * these two so Chat is the place and Opensteer the agent everywhere.
   */
  conversationName: "packages/client/src/host/conversation-presentation.ts",
  /**
   * Every engine that can point at an OpenAI-compatible endpoint reads the
   * same model list. A second copy is how two engines start disagreeing about
   * which canonical model a gateway's id names.
   */
  compatibleEndpointHost: "packages/harness/src/compatible-endpoint.ts",
  compatibleModelDescriptors: "packages/harness/src/compatible-endpoint.ts",
  compatibleModelHint: "packages/harness/src/compatible-endpoint.ts",
  createPrivateFileAtomically: "packages/shared/src/atomicPrivateFile.ts",
  decodeBase64Url: "packages/shared/src/base64url.ts",
  Deferred: "packages/harness/src/deferred.ts",
  delay: "packages/shared/src/delay.ts",
  describeConnectionAccess: "packages/client/src/connections/connection-resolver.ts",
  ensurePrivateDirectory: "packages/shared/src/privateFiles.ts",
  encodeBase64Url: "packages/shared/src/base64url.ts",
  /**
   * The 4-byte big-endian length before a JSON body, which the computer use
   * helper socket and the shell helper's init frame both speak. It had a copy
   * per caller; one reader keeps its size check in one place.
   */
  encodeLengthPrefixedJson: "packages/shared/src/lengthPrefixedJson.ts",
  /**
   * Desktop child-process policy, not a cross-cutting helper: one allowlist
   * for the login-shell probe, the Windows account read, and the Personal
   * stack's base environment.
   */
  filterUserEnvironment: "apps/desktop/src/supervisor/personal-user-environment.ts",
  formatIssues: "packages/shared/src/validationIssues.ts",
  /**
   * The `[Opensteer input]` envelope and the escaping that stops a Trigger
   * payload or another agent from opening a second header and claiming to be
   * the user. One copy per engine is one place for that guard to be forgotten.
   */
  harnessInputAuthorLabel: "packages/harness/src/input-projection.ts",
  harnessInputHeader: "packages/harness/src/input-projection.ts",
  hasAsciiControl: "packages/protocol/src/desktop.ts",
  headerText: "packages/harness/src/input-projection.ts",
  /** A checkout's build-output lock: a second copy would be a second, unseen lock. */
  holdCheckoutWrites: "packages/shared/src/kernelLock.ts",
  holdKernelLocks: "packages/shared/src/kernelLock.ts",
  holdQueuedSlot: "scripts/test-vm/slot-queue.ts",
  /** One way to stop a command's process group: bounded, then joined before any lock is released. */
  stopProcessGroup: "packages/shared/src/processGroup.ts",
  isNodeError: "packages/shared/src/nodeError.ts",
  LengthPrefixedJsonReader: "packages/shared/src/lengthPrefixedJson.ts",
  isRecord: "packages/shared/src/isRecord.ts",
  integrationToolEffect: "packages/integration-core/src/effect.ts",
  messageAuthorName: "packages/client/src/host/conversation-presentation.ts",
  HarnessSessionRegistry: "packages/harness/src/session-registry.ts",
  MutationQueue: "packages/shared/src/mutationQueue.ts",
  digestSecret: "packages/shared/src/secretDigest.ts",
  hostedOAuthDeploymentAuthorityDigest: "packages/integration-auth/src/broker-sealing.ts",
  equalSecretDigests: "packages/shared/src/secretDigest.ts",
  noFollowFlag: "packages/shared/src/privateFiles.ts",
  opensteerToolIdentity: "packages/harness/src/tool-identity.ts",
  normalizeEd25519PrivateKey: "packages/shared/src/proof.ts",
  normalizeEd25519PublicKey: "packages/shared/src/proof.ts",
  parseInput: "packages/workspace-portablefs/src/parsing.ts",
  providerSecretFile: "packages/harness/src/provider-secret-file.ts",
  rawDataBuffer: "packages/shared/src/webSocketFrame.ts",
  readBounded: "packages/shared/src/privateFiles.ts",
  reasoningEffortLabel: "packages/harness/src/labels.ts",
  readBoundedJson: "packages/shared/src/boundedJson.ts",
  readPrivateFileText: "packages/shared/src/atomicPrivateFile.ts",
  /**
   * The one way a supervisor hands a service its credentials off the
   * environment every same-user process can read. A second reader is a second
   * format for the desktop to keep in step with.
   */
  readProcessSecrets: "packages/shared/src/processSecrets.ts",
  refuseConnection: "packages/shared/src/httpServer.ts",
  replacePrivateFileAtomically: "packages/shared/src/atomicPrivateFile.ts",
  resolveConnection: "packages/client/src/connections/connection-resolver.ts",
  RestartPolicy: "packages/shared/src/restartPolicy.ts",
  runHarnessCliLogout: "packages/harness/src/cli-logout.ts",
  safeMessage: "packages/shared/src/safeMessage.ts",
  sameStringSet: "packages/core/src/collections.ts",
  secretInputAuthentication: "packages/harness/src/secret-authentication.ts",
  securePrivateDirectory: "packages/shared/src/atomicPrivateFile.ts",
  syncDirectory: "packages/shared/src/privateFiles.ts",
  throwIfAborted: "packages/shared/src/throwIfAborted.ts",
  tryKernelLock: "packages/shared/src/kernelLock.ts",
  titleCase: "packages/harness/src/labels.ts",
  toHarnessError: "packages/harness/src/errors.ts",
  toHarnessTransportError: "packages/harness/src/errors.ts",
  tokenDigest: "packages/core/src/crypto.ts",
  TurnPublisher: "packages/harness/src/turn-publisher.ts",
  withTimeout: "packages/shared/src/withTimeout.ts",
  writePrivateTemporaryFile: "packages/shared/src/atomicPrivateFile.ts",
};

describe("shared helper homes", () => {
  it.each(Object.entries(helperHomes))("defines %s only in %s", (name, expected) => {
    const matches = [...sources]
      .filter(([, source]) => declarationOf(name).test(source))
      .map(([file]) => file)
      .sort();

    expect(matches).toEqual(typeof expected === "string" ? [expected] : [...expected].sort());
  });

  /**
   * `sortJson` had three copies whose locale-sensitive key ordering made the
   * fingerprints they fed machine-dependent. Nothing may reintroduce the name:
   * canonical JSON is `canonicalJson`.
   */
  it("keeps ad-hoc canonical JSON serializers out of the tree", () => {
    const matches = [...sources]
      .filter(([, source]) => declarationOf("sortJson").test(source))
      .map(([file]) => file);

    expect(matches).toEqual([]);
  });

  it("keeps no-follow and filesystem-mode primitives in privateFiles", () => {
    const violations = productionSources().filter(
      ([file, source]) =>
        file !== "packages/shared/src/privateFiles.ts" &&
        (/\bO_NOFOLLOW\b/u.test(source) ||
          /\bchmodSync\s*\(/u.test(source) ||
          /\bchmod\s*\(/u.test(source) ||
          /\.chmod\s*\(/u.test(source)),
    );

    expect(violations.map(([file]) => file)).toEqual([]);
  });

  it("sees a class declaration, not only functions and arrow constants", () => {
    const matcher = declarationOf("ExampleHelper");

    expect(matcher.test("export class ExampleHelper {")).toBe(true);
    expect(matcher.test("abstract class ExampleHelper extends Base {")).toBe(true);
    expect(matcher.test("const helper = new ExampleHelper();")).toBe(false);
  });

  it("keeps bounded HTTP body readers in boundedJson", () => {
    const violations = [...sources].filter(
      ([file, source]) =>
        file !== "packages/shared/src/boundedJson.ts" &&
        /(?:\.body|\bbody)\??\.getReader\s*\(/u.test(source),
    );

    expect(violations.map(([file]) => file)).toEqual([]);
  });
});

/**
 * A helper is declared as a function, an arrow constant, or a class. Without
 * the class branch a pinned class matches nothing at all and the pin passes
 * while every copy of it goes unseen.
 */
function declarationOf(name: string): RegExp {
  return new RegExp(
    `\\bfunction\\s+${name}\\b|\\bclass\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^;]*?\\)|[A-Za-z_$][\\w$]*)\\s*=>`,
    "u",
  );
}

function productionSources(): [string, string][] {
  return [...sources].filter(
    ([file]) =>
      !file.includes(".test.") &&
      (file.startsWith("apps/") || file.startsWith("packages/") || file.startsWith("scripts/")),
  );
}
