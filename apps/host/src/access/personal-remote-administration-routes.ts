import type { FastifyInstance } from "fastify";
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  DesktopSupervisorInputSchema,
  type DesktopSupervisorOutput,
} from "@opensteer/protocol/desktop-supervisor";
import type { LocalBootstrapService } from "../runtime/local-bootstrap.js";
import type { PersonalRemoteAdministration } from "./personal-remote-administration.js";
import type { PersonalDesktopUpdate } from "./personal-desktop-update.js";

export function registerPersonalRemoteExecutor(
  app: FastifyInstance,
  supervisor: Pick<LocalBootstrapService, "requireSupervisor">,
  administration: PersonalRemoteAdministration,
  updates?: PersonalDesktopUpdate,
): void {
  app.addHook("preClose", async () => {
    administration.close();
    updates?.close();
  });
  app.get("/v1/desktop-supervisor", { websocket: true }, (socket, request) => {
    let detach = () => {};
    let detachUpdates = () => {};
    let unsubscribe = () => {};
    let unsubscribeUpdates = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let alive = true;
    let admitted = false;
    let hello = false;
    socket.on("pong", () => {
      alive = true;
    });
    const authorize = () => supervisor.requireSupervisor(request.headers.authorization);
    const fail = () => socket.close(1008, "Desktop supervisor authentication or protocol failed");
    const send = (message: DesktopSupervisorOutput) => {
      if (!closed) socket.send(JSON.stringify(message));
    };
    // Serialize delivery: a delayed read cannot overtake a newer Off intent.
    let publishing = Promise.resolve();
    const publish = () =>
      (publishing = publishing.then(async () => {
        if (closed || !hello) return;
        authorize();
        const operation = await administration.next(socket);
        if (operation) send({ type: "remote-access.operation", operation });
        const update = await updates?.next(socket);
        if (update) send({ type: "desktop-update.operation", operation: update });
      }));
    socket.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeUpdates();
      detach();
      detachUpdates();
    });
    let tail = Promise.resolve();
    socket.on("message", (data) => {
      tail = tail
        .then(async () => {
          if (!admitted || data.toString().length > 16_384)
            throw new Error("Invalid supervisor frame");
          authorize();
          const message = DesktopSupervisorInputSchema.parse(JSON.parse(data.toString()));
          if (message.type === "hello") {
            if (hello) throw new Error("Duplicate supervisor hello");
            detachUpdates =
              (await updates?.attachExecutor(socket, message.incarnationId, message.state)) ??
              (() => {});
            if (closed) {
              detachUpdates();
              return;
            }
            hello = true;
            send({ type: "ack", messageId: message.messageId, accepted: true });
            await publish();
            return;
          }
          if (!hello) throw new Error("Supervisor hello required");
          if (message.type === "desktop-update.state") {
            updates?.state(socket, message.state);
            return;
          }
          try {
            if (message.type === "remote-access.progress")
              await administration.progress(socket, message.progress);
            else {
              if (!updates) throw new Error("Desktop updates unavailable");
              await updates.progress(socket, message);
            }
            send({ type: "ack", messageId: message.messageId, accepted: true });
          } catch {
            send({ type: "ack", messageId: message.messageId, accepted: false });
          }
        })
        .catch(fail);
    });
    void (async () => {
      if (
        new URL(request.url, "http://host.invalid").searchParams.get("apiVersion") !==
        String(hostApiVersion)
      )
        throw new Error("Unsupported supervisor protocol");
      authorize();
      if (closed) return;
      detach = administration.attachExecutor(socket);
      admitted = true;
      unsubscribe = administration.subscribe(() => void publish().catch(fail));
      unsubscribeUpdates = updates?.subscribe(() => void publish().catch(fail)) ?? (() => {});
      heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        try {
          authorize();
          socket.ping();
        } catch {
          fail();
        }
      }, 30_000);
      heartbeat.unref?.();
    })().catch(fail);
  });
}
