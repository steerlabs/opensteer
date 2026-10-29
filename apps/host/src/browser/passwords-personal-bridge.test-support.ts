import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ComputerUseBridgeRequestSchema,
  PasswordSignInAuthorityCommandSchema,
  type PasswordSignInAuthorityCommand,
  type PasswordSignInAuthorityEvent,
  type PasswordSignInAuthorityResult,
} from "@opensteer/protocol";
import { passwordFixture, sealFixtureLogin } from "./passwords-authority.test-support.js";

type Authorization = Extract<PasswordSignInAuthorityCommand, { type: "login.authorize" }>;

/**
 * Scripted desktop vault/person, behind the real Main Runner's authenticated
 * bridge. It never calls an agent tool or sends a Thread message. Observation
 * of a Request cannot approve it: the journey must separately act as its owner.
 * Failures: wrong card, pre-approval seal, cancelled/expired operation, mismatched
 * reference or Workspace, unsupported methods and malformed protocol frames.
 */
export async function startPersonalPasswordsBridge() {
  const token = randomUUID();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No authority bridge port");
  const commands: PasswordSignInAuthorityCommand[] = [];
  const protocolErrors: string[] = [];
  const approvals: { operationId: string; workspaceId: string; permissionVersion: 5 }[] = [];
  const operations = new Map<
    string,
    { command: Authorization; socket: WebSocket; approved: boolean }
  >();
  const emit = (socket: WebSocket, params: PasswordSignInAuthorityEvent) =>
    socket.send(JSON.stringify({ kind: "event", event: "passwords.event", params }));
  server.on("connection", (socket, request) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      socket.close(1008, "unauthorized");
      return;
    }
    socket.on("close", () => {
      for (const [id, operation] of operations)
        if (operation.socket === socket) operations.delete(id);
    });
    socket.on("message", (raw, binary) => {
      if (binary) {
        protocolErrors.push("Unexpected binary bridge frame");
        return;
      }
      try {
        const request = ComputerUseBridgeRequestSchema.parse(JSON.parse(raw.toString()));
        const reply = (result: object) =>
          socket.send(JSON.stringify({ id: request.id, kind: "response", result }));
        if (request.method === "permissions.get" || request.method === "permissions.request") {
          reply({ permissions: { accessibility: "granted", screenRecording: "granted" } });
          return;
        }
        if (request.method === "passwords.capabilities") {
          reply({ authority: 1, receiver: null });
          return;
        }
        if (request.method === "approvals.list" || request.method === "approvals.outcome") {
          reply({});
          return;
        }
        if (request.method !== "passwords.control") {
          socket.send(
            JSON.stringify({
              id: request.id,
              kind: "response",
              error: { code: "unsupported", message: "This fixture offers only saved sign-ins." },
            }),
          );
          return;
        }
        const command = PasswordSignInAuthorityCommandSchema.parse(request.params);
        commands.push(command);
        const answer = (result: PasswordSignInAuthorityResult) => reply(result);
        switch (command.type) {
          case "signin.probe":
            answer({ type: "signin.probe.result", passwords: "has-login" });
            break;
          case "login.authorize":
            operations.set(command.operationId, { command, socket, approved: false });
            answer({ type: "login.authorize.started" });
            emit(socket, {
              type: "login.needs",
              operationId: command.operationId,
              need: "approval",
            });
            break;
          case "login.cancel":
            operations.delete(command.operationId);
            answer({ type: "login.cancelled" });
            break;
          case "login.seal": {
            const operation = operations.get(command.operationId);
            if (!operation || Date.parse(operation.command.expiresAt) <= Date.now()) {
              answer({ type: "login.seal.result", status: "expired" });
              break;
            }
            if (
              !operation.approved ||
              command.binding.expiresAt > Date.parse(operation.command.expiresAt) ||
              command.binding.connectionId !== command.receiver.connectionId ||
              command.binding.connectionGeneration !== command.receiver.connectionGeneration
            ) {
              answer({ type: "login.seal.result", status: "denied" });
              break;
            }
            answer({
              type: "login.seal.result",
              status: "sealed",
              envelope: sealFixtureLogin({
                value: passwordFixture[command.binding.field],
                receiver: command.receiver,
                binding: command.binding,
                now: Date.now(),
              }),
            });
            break;
          }
        }
      } catch {
        protocolErrors.push("Invalid authority bridge request");
        socket.close(1008, "invalid request");
      }
    });
  });
  return {
    bridge: { token, url: new URL(`ws://127.0.0.1:${address.port}`) },
    commands,
    approvals,
    protocolErrors,
    /** A person chooses Allow on the observed, Workspace-scoped v5 sign-in card. */
    approve(card: {
      operationId: string;
      workspaceId: string;
      site: string;
      scope: string;
      permissionVersion: number;
    }) {
      const operation = operations.get(card.operationId);
      if (
        !operation ||
        operation.approved ||
        Date.parse(operation.command.expiresAt) <= Date.now() ||
        card.workspaceId !== operation.command.workspaceId ||
        card.site !== operation.command.site ||
        card.scope !== "workspace" ||
        card.permissionVersion !== 5
      )
        throw new Error("That sign-in card cannot be approved");
      operation.approved = true;
      approvals.push({
        operationId: card.operationId,
        workspaceId: card.workspaceId,
        permissionVersion: 5,
      });
      emit(operation.socket, {
        type: "login.result",
        operationId: card.operationId,
        outcome: {
          kind: "authorized",
          loginRef: operation.command.loginRef,
          expiresAt: operation.command.expiresAt,
          account: passwordFixture.account,
        },
      });
    },
    async close() {
      operations.clear();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
