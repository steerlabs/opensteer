import type { FastifyInstance } from "fastify";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { PersonalRemoteExecutorProgressSchema } from "@opensteer/protocol";
import type { HostAuthenticator } from "../identity/auth.js";
import {
  requirePersonalAdministrator,
  type PersonalRemoteAdministration,
} from "./personal-remote-administration.js";

export function registerPersonalRemoteExecutor(
  app: FastifyInstance,
  authenticator: HostAuthenticator,
  administration: PersonalRemoteAdministration,
): void {
  app.addHook("preClose", async () => administration.close());
  app.get("/v1/personal-remote-access/executor", { websocket: true }, (socket, request) => {
    let detach = () => {};
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const authorize = async () => {
      const authenticated = await authenticator.authenticateSession(request.headers, {
        mutation: true,
      });
      requirePersonalAdministrator(authenticated);
    };
    const fail = () =>
      socket.close(1008, "Remote access executor authentication or protocol failed");
    // A delayed read must never deliver an older intent after a newer Off request.
    let publishing = Promise.resolve();
    const publish = () =>
      (publishing = publishing.then(async () => {
        if (closed) return;
        await authorize();
        const operation = await administration.next(socket);
        if (!closed && operation) socket.send(JSON.stringify(operation));
      }));
    socket.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      detach();
    });
    // Install the receiver before the first asynchronous admission work.
    let admitted = false;
    let tail = Promise.resolve();
    socket.on("message", (data) => {
      tail = tail
        .then(async () => {
          if (!admitted || data.toString().length > 8192) throw new Error("Invalid executor frame");
          await authorize();
          await administration.progress(
            socket,
            PersonalRemoteExecutorProgressSchema.parse(JSON.parse(data.toString())),
          );
        })
        .catch(fail);
    });
    void (async () => {
      if (
        new URL(request.url, "http://host.invalid").searchParams.get("apiVersion") !==
        String(hostApiVersion)
      )
        throw new Error("Unsupported executor protocol");
      await authorize();
      if (closed) return;
      detach = administration.attachExecutor(socket);
      admitted = true;
      unsubscribe = administration.subscribe(() => void publish().catch(fail));
      heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        void authorize()
          .then(() => socket.ping())
          .catch(fail);
      }, 30_000);
      heartbeat.unref?.();
      await publish();
    })().catch(fail);
  });
}
