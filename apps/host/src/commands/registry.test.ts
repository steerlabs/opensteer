import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "@opensteer/core";
import type { HostApiCommand, HostApiServerContext } from "@opensteer/protocol";
import { commandTable, type CommandType } from "@opensteer/protocol/command-table";

const routed = vi.hoisted(() => ({ family: [] as string[] }));
vi.mock("../triggers/trigger-routes.js", () => ({
  handleTriggerCommand: async (_s: unknown, c: { type: string }) => {
    routed.family.push("triggers");
    return { type: c.type };
  },
}));
vi.mock("../devices/device-routes.js", () => ({
  handleDeviceCommand: async (_s: unknown, c: { type: string }) => {
    routed.family.push("devices");
    return { type: c.type };
  },
}));
vi.mock("../channels/channel-handlers.js", () => ({
  handleChannelCommand: async (_s: unknown, c: { type: string }) => {
    routed.family.push("channels");
    return { type: c.type };
  },
}));
vi.mock("../server/browser-source-registration.js", async (original) => ({
  ...(await original<object>()),
  handleBrowserSourceCommand: async (_s: unknown, c: { type: string }) => {
    routed.family.push("browser-sources");
    return { type: c.type };
  },
}));
vi.mock("../plugins/plugin-oauth-routes.js", async (original) => ({
  ...(await original<object>()),
  handlePluginOAuthCommand: async (_s: unknown, c: { type: string }) => {
    routed.family.push("plugin-sign-in");
    return { type: c.type };
  },
}));

const { createCommandRegistry } = await import("./registry.js");
type PersonCommandHandler<K extends CommandType> = import("./registry.js").PersonCommandHandler<K>;
const { personActor } = await import("./actor.js");

/** Where the person's `commands.dispatch` sent each type before the door existed. */
const expectedFamily = (type: CommandType): string => {
  if (type === "request.command.approve") return "command-requests";
  if (type === "computer.view.close" || type === "computer.view.renew") return "computer-views";
  if (type.startsWith("plugins.")) return "plugins";
  if (
    type.startsWith("browser.source.") ||
    type === "browser.site.remove" ||
    type === "browser.session.sign-in" ||
    type === "browser.sign-in.respond" ||
    type === "browser.password-sign-in.respond"
  )
    return "browser-sources";
  if (type.startsWith("plugin.authorization.") || type.startsWith("plugin.oauthApp."))
    return "plugin-sign-in";
  if (type.startsWith("trigger.")) return "triggers";
  if (type === "plugin.remove" || type.startsWith("integration.")) return "devices";
  if (type.startsWith("channel.")) return "channels";
  return "core";
};

describe("the command registry", () => {
  it("sends every type to the family the person's dispatch always used", async () => {
    const context = {
      session: { id: "ses_1", user: { id: "usr_1" } } as unknown as AuthenticatedSession,
    } as unknown as HostApiServerContext;
    const registry = createCommandRegistry({
      triggers: {} as never,
      devices: {} as never,
      channels: {} as never,
      browserSources: {} as never,
      approveCommand: async (_actor, command) => {
        routed.family.push("command-requests");
        return { type: command.type } as never;
      },
      handleCoreCommand: async (command) => {
        routed.family.push("core");
        return { type: command.type } as never;
      },
      computerViews: {
        command: async () => {
          routed.family.push("computer-views");
          return {} as never;
        },
      } as never,
      plugins: {
        command: async (command: { type: string }) => {
          routed.family.push("plugins");
          return { type: command.type };
        },
      } as never,
      secretDigestKey: Buffer.alloc(32, 0x33),
    });
    for (const type of Object.keys(commandTable) as CommandType[]) {
      routed.family.length = 0;
      expect(registry[type].accepts).toBe("person");
      await (registry[type] as PersonCommandHandler<CommandType>).run(
        personActor(context),
        { type } as unknown as Extract<HostApiCommand, { type: typeof type }> as never,
        context,
      );
      expect({ type, family: routed.family }).toEqual({ type, family: [expectedFamily(type)] });
    }
  });
});
