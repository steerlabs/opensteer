import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  SessionCdpRouter as PortableSessionCdpRouter,
  type BrowserCdpBackend,
  type SessionCdpRouterLimits,
} from "./portable-session-cdp-router.js";
export * from "./portable-session-cdp-router.js";
export class SessionCdpRouter extends PortableSessionCdpRouter {
  constructor(
    backend: BrowserCdpBackend,
    limits: Partial<SessionCdpRouterLimits> = {},
    machineClipboardShared = true,
  ) {
    super(
      backend,
      {
        uuid: randomUUID,
        isNormalizedAbsolutePath: (value) =>
          path.isAbsolute(value) && path.resolve(value) === value,
        containsFile: (root, value) => value.startsWith(`${root}${path.sep}`),
      },
      limits,
      machineClipboardShared,
    );
  }
}
