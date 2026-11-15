import { appListItem, type AppService } from "../../apps/app-service.js";
import { requireRun } from "../operations.js";
import type { AgentToolHandlers } from "./types.js";

type AppToolName = "app_publish" | "app_list" | "app_start" | "app_stop" | "app_delete";

/** Agents reach the same person-owned lifecycle the Apps page uses. */
export function appToolHandlers(
  apps: Pick<AppService, "publish" | "list" | "start" | "stop" | "delete">,
): Pick<AgentToolHandlers, AppToolName> {
  const run = (caller: Parameters<typeof requireRun>[0]) =>
    ({ kind: "run", claims: requireRun(caller).claims }) as const;
  return {
    app_publish: async (c) => apps.publish(requireRun(c.caller).claims, c.operationKey, c.input, c),
    app_list: async (c) => ({
      apps: (
        await apps.list(
          c.caller.kind === "run"
            ? run(c.caller)
            : c.caller.kind === "connection"
              ? { kind: "connection", caller: c.caller }
              : { kind: "program", caller: c.caller },
          c.input.query,
          c,
        )
      ).map(appListItem),
    }),
    app_start: async (c) => ({ app: await apps.start(run(c.caller), c.input.appId, c) }),
    app_stop: async (c) => ({ app: await apps.stop(run(c.caller), c.input.appId, c) }),
    app_delete: async (c) => {
      await apps.delete(run(c.caller), c.input.appId, c);
      return { appId: c.input.appId, deleted: true as const };
    },
  };
}
