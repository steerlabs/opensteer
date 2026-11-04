import { requestTitleText, type UserId, type WaitingRequest } from "@opensteer/core";
import { hostApi, rpcSuccess, type DurableWindow, type HostApiHandlers } from "@opensteer/protocol";
import { requireSession } from "../integrations/integration-rpc-context.js";

export function createSettingsReadHandlers(options: {
  readonly catalog: () => Promise<
    readonly { definitionId: string; title: string; description: string; added: boolean }[]
  >;
  readonly requests: (
    owner: UserId,
  ) => Promise<{ readonly requests: readonly WaitingRequest[]; readonly window: DurableWindow }>;
  readonly machines: HostApiHandlers["machines.list"];
}): Pick<HostApiHandlers, "plugins.directory.get" | "devices.overview.get"> {
  return {
    "plugins.directory.get": async (_input, context) => {
      const owner = requireSession(context).user.id;
      const [catalog, pending] = await Promise.all([options.catalog(), options.requests(owner)]);
      return rpcSuccess(
        hostApi["plugins.directory.get"].success.parse({
          catalog,
          requests: pending.requests
            .filter(
              ({ request }) =>
                request.kind === "integration.install" || request.kind === "integration.access",
            )
            .map(({ request }) => ({
              requestId: request.id,
              title: requestTitleText(request.presentation).slice(0, 120),
              workspaceId: request.originatingWorkspaceId,
            })),
          hasMoreRequests: pending.window.hasMore,
        }),
      );
    },
    "devices.overview.get": async (_input, context) => {
      requireSession(context);
      const result = await options.machines({}, context);
      if (!result.ok) return result;
      return rpcSuccess(
        hostApi["devices.overview.get"].success.parse({ devices: result.data.machines }),
      );
    },
  };
}
