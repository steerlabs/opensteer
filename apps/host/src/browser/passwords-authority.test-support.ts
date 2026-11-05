import { createCipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import {
  PasswordSignInAuthorityCommandSchema,
  type PasswordSignInAuthorityEvent,
  type PasswordSignInAuthorityCommand,
  type PasswordSignInAuthorityResult,
} from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  type LoginEnvelopeBinding,
  type LoginReceiverKey,
  SealedLoginEnvelopeSchema,
} from "@opensteer/protocol";
import { openAuxiliaryStream } from "../runtime/computer-apps.test-support.js";
import {
  closed,
  waitForMessage,
  type PrimaryConnection,
} from "../runtime/machine-access.test-support.js";

export const passwordFixture = {
  site: "https://passwords-fixture.test",
  username: "synthetic.person@passwords-fixture.test",
  password: "pw-canary-7d8bde4e-709c-47e5-86ad-f61c9e2ffda0",
  code: "028491",
  account: "s•••@passwords-fixture.test",
} as const;

/** Scripted vault desktop, authenticated by the real Runner handshake. No browser module. */
export async function startPasswordsAuthority(hostPort: number, primary: PrimaryConnection) {
  const stream = await openAuxiliaryStream(hostPort, primary, "integrations");
  const commands: PasswordSignInAuthorityCommand[] = [];
  const protocolErrors: string[] = [];
  const operations = new Map<
    string,
    Extract<PasswordSignInAuthorityCommand, { type: "login.authorize"; loginRef: string }>
  >();
  const cards = new Map<
    string,
    Extract<PasswordSignInAuthorityCommand, { type: "login.authorize"; credential: "card" }>
  >();
  const cardChoice = {
    id: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    brand: "Visa",
    lastFour: "4242",
    label: null,
    expiryMonth: 1,
    expiryYear: 2030,
  };
  const policy = {
    approval: false,
    declined: false,
    hasTOTP: true,
    revoked: false,
    revisionChanged: false,
    expired: false,
    holdSeal: false,
  };
  const values = {
    username: String(passwordFixture.username),
    password: String(passwordFixture.password),
    code: String(passwordFixture.code),
  };
  let held: (() => void)[] = [];
  const send = (frame: Record<string, unknown>) =>
    stream.socket.send(JSON.stringify({ ...stream.fence, ...frame }));
  const event = (event: PasswordSignInAuthorityEvent) =>
    send({ type: "runner.integrations.password-sign-in-event", event });
  const authorize = (operationId: string) => {
    const operation = operations.get(operationId);
    if (!operation) throw new Error("Unknown fixture authorization");
    event({
      type: "login.result",
      operationId,
      outcome: policy.declined
        ? { kind: "declined" }
        : {
            kind: "authorized",
            loginRef: operation.loginRef,
            expiresAt: operation.expiresAt,
            account: passwordFixture.account,
          },
    });
  };
  const status = (available = true) =>
    send({
      type: "runner.integrations.status",
      apps: [],
      ...(available ? { passwordSignIn: 2 } : {}),
    });
  stream.socket.on("message", (raw, binary) => {
    if (binary) return;
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (frame.type !== "host.integrations.password-sign-in") return;
    const parsed = PasswordSignInAuthorityCommandSchema.safeParse(frame.command);
    if (!parsed.success) {
      protocolErrors.push("Invalid authority command");
      return;
    }
    const command = parsed.data;
    commands.push(command);
    const reply = (result: PasswordSignInAuthorityResult) =>
      send({
        type: "runner.integrations.password-sign-in-result",
        requestId: frame.requestId,
        result,
      });
    switch (command.type) {
      case "card.probe":
        reply({ type: "card.probe.result", cards: "has-card" });
        break;
      case "signin.probe":
        reply({ type: "signin.probe.result", passwords: "has-login" });
        break;
      case "login.get":
        if (cards.has(command.operationId)) {
          reply({
            type: "login.get.result",
            card: { stage: "card-approval", permissionVersion: 7, cards: [cardChoice] },
          });
          break;
        }
        reply({
          type: "login.get.result",
          card: {
            stage: "approval",
            permissionVersion: 5,
            accounts: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                revision: 1,
                username: passwordFixture.username,
                host: "passwords-fixture.test",
                onPage: false,
                updatedAt: new Date().toISOString(),
                label: null,
              },
            ],
          },
        });
        break;
      case "login.approve":
        if ("credential" in command) {
          const card = cards.get(command.operationId);
          if (!card) throw new Error("Unknown card operation");
          event({
            type: "login.result",
            operationId: command.operationId,
            outcome: {
              kind: "authorized",
              cardRef: card.cardRef,
              brand: cardChoice.brand,
              lastFour: cardChoice.lastFour,
              expiresAt: card.expiresAt,
            },
          });
          reply({ type: "login.approve.result", result: { ok: true } });
          break;
        }
        authorize(command.operationId);
        reply({ type: "login.approve.result", result: { ok: true } });
        break;
      case "login.commit":
        reply({
          type: "login.committed",
          committed: !policy.revoked && !policy.expired && !policy.revisionChanged,
        });
        break;
      case "login.authorize":
        if ("cardRef" in command) {
          cards.set(command.operationId, command);
          reply({ type: "login.authorize.started" });
          event({ type: "login.needs", operationId: command.operationId, need: "approval" });
          break;
        }
        operations.set(command.operationId, command);
        reply({ type: "login.authorize.started" });
        if (policy.approval)
          event({ type: "login.needs", operationId: command.operationId, need: "approval" });
        else authorize(command.operationId);
        break;
      case "login.cancel":
        cards.delete(command.operationId);
        operations.delete(command.operationId);
        reply({ type: "login.cancelled" });
        break;
      case "login.seal": {
        const seal = () => {
          const operation = operations.get(command.operationId);
          if (!operation || policy.expired || Date.parse(operation.expiresAt) <= Date.now()) {
            reply({ type: "login.seal.result", status: "expired" });
            return;
          }
          if (policy.revoked || policy.revisionChanged) {
            reply({ type: "login.seal.result", status: "denied" });
            return;
          }
          if (command.binding.field === "code" && !policy.hasTOTP) {
            reply({ type: "login.seal.result", status: "unavailable" });
            return;
          }
          reply({
            type: "login.seal.result",
            status: "sealed",
            envelope: sealFixtureLogin({
              value: values[command.binding.field],
              receiver: command.receiver,
              binding: command.binding,
              now: Date.now(),
            }),
          });
        };
        if (policy.holdSeal) held.push(seal);
        else seal();
        break;
      }
    }
  });
  status();
  return {
    commands,
    protocolErrors,
    policy,
    values,
    authorize,
    status,
    runnerId: primary.fence.runnerId,
    end: async (operationId: string) => {
      operations.delete(operationId);
      event({ type: "login.ended", operationId });
      // A domain heartbeat is ordered behind the event in the Host's auxiliary inbox.
      const acknowledged = waitForMessage(
        stream.socket,
        (frame) => frame.type === "host.auxiliary.lease-renewed",
        5_000,
      );
      send({ type: "runner.auxiliary.heartbeat", sentAt: new Date().toISOString() });
      await acknowledged.catch(() => {
        throw new Error("Host did not acknowledge the Passwords authority event.");
      });
    },
    releaseHeld: () => {
      const ready = held;
      held = [];
      for (const seal of ready) seal();
    },
    close: async () => {
      held = [];
      stream.socket.close();
      await closed(stream.socket);
    },
    id: randomUUID(),
  };
}

/** Independent vault fixture: the real Android/native receiver must authenticate these bytes. */
export function sealFixtureLogin(input: {
  value: string;
  receiver: LoginReceiverKey;
  binding: LoginEnvelopeBinding;
  now: number;
}) {
  if (input.binding.expiresAt <= input.now) throw new Error("Fixture seal expired");
  const sender = createECDH("prime256v1");
  sender.generateKeys();
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const shared = sender.computeSecret(Buffer.from(input.receiver.publicKey, "base64url"));
  const key = Buffer.from(hkdfSync("sha256", shared, salt, "opensteer/login-text/v1", 32));
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(canonicalJson(input.binding)));
    const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
    return SealedLoginEnvelopeSchema.parse({
      binding: input.binding,
      senderPublicKey: sender.getPublicKey(undefined, "uncompressed").toString("base64url"),
      salt: salt.toString("base64url"),
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    });
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}
