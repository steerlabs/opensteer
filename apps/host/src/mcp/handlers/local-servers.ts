import { agentGrantAccess } from "@opensteer/core";
import { callerLineage } from "../agent-caller.js";
import type { LocalServerRegistry } from "../../local-servers/local-server-registry.js";
import { requireRun, operationId } from "../operations.js";
import type { AgentToolHandlers } from "./types.js";

export function localServerToolHandlers(registry: LocalServerRegistry): Partial<AgentToolHandlers> {
  return {
    local_server_add: async (c) => {
      const run = requireRun(c.caller);
      const { operationKey: _operationKey, ...registration } = c.input;
      return registry.add(
        { userId: run.userId, threadId: run.thread.id },
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
      const run = requireRun(c.caller);
      return registry.remove(
        { userId: run.userId },
        c.input.name,
        operationId(c.caller, c.operationKey, "local_server_remove"),
        c.checkLive,
      );
    },
  };
}
