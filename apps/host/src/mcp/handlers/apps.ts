import { appListItem, type AppActor, type AppService } from "../../apps/app-service.js";
import type { AgentCaller } from "../agent-caller.js";
import { requireRun } from "../operations.js";
import type { AgentToolHandlers } from "./types.js";

type AppToolName = "app_publish" | "app_list" | "app_start" | "app_stop" | "app_delete";

/** Agents reach the same person-owned lifecycle the Apps page uses. */
export function appToolHandlers(
  apps: Pick<AppService, "publish" | "list" | "start" | "stop" | "delete">,
): Pick<AgentToolHandlers, AppToolName> {
  const actor = (caller: AgentCaller): AppActor => {
    if (caller.kind === "run") return { kind: "run", claims: caller.claims };
    if (caller.kind === "program") return { kind: "program", caller };
    return { kind: "run", claims: requireRun(caller).claims };
  };
  return {
    app_publish: async (c) =>
      apps.publish(
        c.caller.kind === "program"
          ? { kind: "program", caller: c.caller }
          : requireRun(c.caller).claims,
        c.operationKey,
        c.input,
        c,
      ),
    app_list: async (c) => ({
      apps: (
        await apps.list(
          c.caller.kind === "connection"
            ? { kind: "connection", caller: c.caller }
            : actor(c.caller),
          c.input.query,
          c,
        )
      ).map(appListItem),
    }),
    app_start: async (c) => ({ app: await apps.start(actor(c.caller), c.input.appId, c) }),
    app_stop: async (c) => ({ app: await apps.stop(actor(c.caller), c.input.appId, c) }),
    app_delete: async (c) => {
      await apps.delete(actor(c.caller), c.input.appId, c);
      return { appId: c.input.appId, deleted: true as const };
    },
  };
}
