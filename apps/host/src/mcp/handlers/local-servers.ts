import { agentGrantAccess } from "@opensteer/core";
import { callerLineage, callerThread } from "../agent-caller.js";
import type { LocalServerRegistry } from "../../local-servers/local-server-registry.js";
import { requireRun, operationId } from "../operations.js";
import type { AgentToolHandlers } from "./types.js";

export function localServerToolHandlers(registry: LocalServerRegistry): Partial<AgentToolHandlers> {
  return {
    local_server_add: async (c) => {
      if (c.caller.kind === "connection") requireRun(c.caller);
      const { operationKey: _operationKey, ...registration } = c.input;
      return registry.add(
        { userId: c.caller.userId, threadId: callerThread(c.caller).id },
        registration,
        operationId(c.caller, c.operationKey, "local_server_add"),
        c.checkLive,
      );
    },
    local_server_list: async (c) => {
      // A selected grant sees only the local servers it names.
      const grant = callerLineage(c.caller)?.grant;
      return {
        servers: await registry.list(c.caller.userId, undefined, (serverId) =>
          grant?.scope === "selected"
            ? agentGrantAccess(grant, {
                kind: "plugin",
                target: { kind: "local-server", serverId },
              }) !== null
            : true,
        ),
      };
    },
    local_server_remove: async (c) => {
      if (c.caller.kind === "connection") requireRun(c.caller);
      return registry.remove(
        { userId: c.caller.userId },
        c.input.name,
        operationId(c.caller, c.operationKey, "local_server_remove"),
        c.checkLive,
      );
    },
  };
}
