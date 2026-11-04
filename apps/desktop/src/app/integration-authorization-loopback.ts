import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  integrationAuthorizationAppReturnBase,
  integrationAuthorizationReturnPath,
  integrationAuthorizationReturnPorts,
} from "@opensteer/integration-core";
import { renderBrowserPage, statusPageBody } from "@opensteer/shared/browserPage";

/** Three short fields. Anything larger is not a return. */
export const integrationAuthorizationLoopbackBodyLimit = 1_024;
const registrationGrace = 60_000;
const maximumConnections = 8;
const maximumHeaderBytes = 4_096;
const defaultDeadlines = { headers: 2_000, request: 5_000, socket: 3_000 } as const;
const formContentType = "application/x-www-form-urlencoded";

const accepted = page({
  mark: "check",
  title: "Continue in Opensteer",
  detail: "You can close this tab.",
  tone: "ok",
});
const refused = page({
  mark: "alert",
  title: "This sign-in didn’t start here",
  detail: "Go back to the Opensteer that asked for it and try again.",
  tone: "warn",
});

function page(input: Parameters<typeof statusPageBody>[0]): string {
  return renderBrowserPage({ body: statusPageBody(input), layout: "plain", title: input.title });
}

/**
 * Receives a consent's return from the browser on this device and hands it to
 * the app-link path, which decides. Only the app that started an attempt holds
 * it, so a return forwarded from another Deployment is refused there.
 */
export class IntegrationAuthorizationLoopback {
  readonly #accept: (appReturn: string) => boolean;
  readonly #deadlines: {
    readonly headers: number;
    readonly request: number;
    readonly socket: number;
  };
  readonly #loginAllowed: () => Promise<boolean>;
  readonly #now: () => number;
  readonly #pendingUntil: () => number | null;
  readonly #ports: readonly number[];
  #grace: number[] = [];
  /** Kept across a session change, because the attempts in flight were sealed to it. */
  #port: number | null = null;
  #server: Server | null = null;
  #starting: Promise<number | null> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    readonly accept: (appReturn: string) => boolean;
    readonly deadlines?: {
      readonly headers: number;
      readonly request: number;
      readonly socket: number;
    };
    /** Whether this computer's logins allow a return on loopback right now. */
    readonly loginAllowed: () => Promise<boolean>;
    readonly now?: () => number;
    /** When the last registered attempt expires; null with none pending. */
    readonly pendingUntil: () => number | null;
    readonly ports?: readonly number[];
  }) {
    this.#accept = options.accept;
    this.#deadlines = options.deadlines ?? defaultDeadlines;
    this.#loginAllowed = options.loginAllowed;
    this.#now = options.now ?? (() => Date.now());
    this.#pendingUntil = options.pendingUntil;
    this.#ports =
      options.ports ??
      Array.from(
        {
          length:
            integrationAuthorizationReturnPorts.last -
            integrationAuthorizationReturnPorts.first +
            1,
        },
        (_, index) => integrationAuthorizationReturnPorts.first + index,
      );
  }

  /** The port to give the Host, or null when this attempt must use the app link. */
  async prepare(): Promise<number | null> {
    if (!(await this.#loginAllowed())) return null;
    this.#grace.push(this.#now() + registrationGrace);
    const port = await this.#listen(
      this.#port === null ? this.#ports : [this.#port, ...this.#ports],
    );
    this.sync();
    return port;
  }

  /** A preparation became an attempt, which now keeps the listener open itself. */
  registered(): void {
    this.#grace.shift();
    this.sync();
  }

  /** Closes the listener once nothing can still arrive on it, now or at the next expiry. */
  sync(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#server === null) return;
    const now = this.#now();
    this.#grace = this.#grace.filter((until) => until > now);
    const remaining = Math.max(this.#pendingUntil() ?? 0, ...this.#grace) - now;
    if (remaining <= 0) {
      void this.close();
      return;
    }
    this.#timer = setTimeout(() => this.sync(), remaining);
    this.#timer.unref?.();
  }

  /**
   * Another login's browser could reach this port while this session is away, so
   * the listener stops. Pending attempts keep their authority; on return they get
   * their sealed port back if it is still free, otherwise they need a fresh attempt.
   */
  async sessionChanged(active: boolean): Promise<void> {
    if (!active) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      await this.#stop();
      return;
    }
    if (this.#port === null) return;
    if (this.#pendingUntil() === null) {
      this.#port = null;
      return;
    }
    await this.#listen([this.#port]);
    this.sync();
  }

  async close(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#grace = [];
    this.#port = null;
    await this.#stop();
  }

  #listen(ports: readonly number[]): Promise<number | null> {
    this.#starting ??= this.#bind(ports).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #bind(ports: readonly number[]): Promise<number | null> {
    if (this.#server !== null) return this.#port;
    for (const port of ports) {
      const server = this.#create(port);
      const bound = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen({ exclusive: true, host: "127.0.0.1", port }, () => resolve(true));
      });
      if (!bound) continue;
      if (!(await this.#loginAllowed())) {
        await closeServer(server);
        return null;
      }
      this.#server = server;
      this.#port = port;
      return port;
    }
    return null;
  }

  #create(port: number): Server {
    const { headers, request, socket } = this.#deadlines;
    const server = createServer(
      {
        // The default 30-second sweep would leave these deadlines unenforced.
        connectionsCheckingInterval: Math.ceil(headers / 4),
        headersTimeout: headers,
        keepAlive: false,
        maxHeaderSize: maximumHeaderBytes,
        requestTimeout: request,
      },
      (incoming, response) => this.#receive(server, port, incoming, response),
    );
    server.maxConnections = maximumConnections;
    server.maxRequestsPerSocket = 1;
    server.setTimeout(socket, (idle) => idle.destroy());
    server.on("clientError", (_error, client) => client.destroy());
    return server;
  }

  #receive(server: Server, port: number, request: IncomingMessage, response: ServerResponse): void {
    const length = Number(request.headers["content-length"]);
    const literal =
      request.method === "POST" &&
      request.headers.host === `127.0.0.1:${port}` &&
      request.url === integrationAuthorizationReturnPath &&
      request.headers["content-type"] === formContentType &&
      request.headers["transfer-encoding"] === undefined &&
      Number.isInteger(length) &&
      length > 0 &&
      length <= integrationAuthorizationLoopbackBodyLimit;
    const chunks: Buffer[] = [];
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > integrationAuthorizationLoopbackBodyLimit) request.destroy();
      else if (literal) chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      void (literal ? this.#deliver(server, body) : Promise.resolve(false)).then(
        (delivered) => send(response, delivered),
        () => send(response, false),
      );
    });
  }

  /**
   * The form's fields become the app return, so the strict app-link parser still
   * decides. Logins can change while this listener is open, with no notification
   * here, so they are read again for every return.
   */
  async #deliver(server: Server, body: string): Promise<boolean> {
    const fields = new URLSearchParams(body);
    if (!fields.has("return")) return false;
    if (!(await this.#loginAllowed()) || server !== this.#server) return false;
    const appReturn = new URL(integrationAuthorizationAppReturnBase("desktop"));
    appReturn.search = fields.toString();
    return this.#accept(appReturn.toString());
  }

  async #stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server !== null) await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function send(response: ServerResponse, delivered: boolean): void {
  response.writeHead(delivered ? 200 : 404, {
    "cache-control": "no-store",
    connection: "close",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(delivered ? accepted : refused);
}
