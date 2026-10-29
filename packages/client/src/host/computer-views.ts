import { ComputerViewRetainers } from "./computer-view-retention.js";
import {
  ComputerViewTargetSchema,
  type ComputerView,
  type HostApiClient,
} from "@opensteer/protocol";
import { HostClientRequestError, type HostClient } from "./client.js";
import { unwrapRpcResult } from "./host-session-client.js";

/**
 * Both network and mock clients use the command boundary, including explicit
 * retry keys. `authority` is the signed-in viewer's generation: an answer
 * asked for by a viewer who has since left is refused, never adopted.
 */
export function computerViewMethods(
  rpc: HostApiClient,
  accept: (view: ComputerView) => void,
  authority: () => number,
  currentView: (viewId: string) => ComputerView | undefined,
  windowsSupported: () => boolean = () => true,
): Pick<
  HostClient,
  | "openComputerView"
  | "closeComputerView"
  | "renewComputerView"
  | "listApprovedComputerApps"
  | "listComputerAppWindows"
  | "retainComputerView"
> &
  Pick<ComputerViewRetainers, "clear" | "setConnected"> {
  const requireAuthority = (started: number) => {
    if (started !== authority())
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "The signed-in account changed while the view was loading.",
      });
  };
  const mutate = async (command: Parameters<HostApiClient["commands.dispatch"]>[0]) => {
    const started = authority();
    const result = unwrapRpcResult(await rpc["commands.dispatch"](command));
    requireAuthority(started);
    if (
      result.type !== "computer.view.open" &&
      result.type !== "computer.view.close" &&
      result.type !== "computer.view.renew"
    )
      throw Error("Unexpected computer view result.");
    accept(result.view);
    return result.view;
  };
  const requireWindows = () => {
    if (!windowsSupported())
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        reason: "computer-view-unsupported",
        message: "Update this Host to choose app windows.",
      });
  };
  const requireLive = (viewId: string, generation: number) => {
    const view = currentView(viewId);
    if (!view || view.generation !== generation || view.state !== "ready")
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        reason:
          view && view.generation !== generation
            ? "computer-view-stale-generation"
            : "computer-view-ended",
        message: "This view has ended. Open it again.",
      });
  };
  const renew = async (viewId: string, generation: number, idempotencyKey: string) => {
    requireLive(viewId, generation);
    return mutate({ type: "computer.view.renew", viewId, generation, idempotencyKey });
  };
  const retainers = new ComputerViewRetainers(
    async (viewId, generation) => renew(viewId, generation, `view-renew:${crypto.randomUUID()}`),
    (viewId, generation) => {
      const view = currentView(viewId);
      return view?.generation === generation && view.state === "ready";
    },
  );
  return {
    clear: () => retainers.clear(),
    setConnected: (connected) => retainers.setConnected(connected),
    retainComputerView: (viewId, generation, options = {}) =>
      retainers.retain(viewId, generation, options.visible ?? true),
    openComputerView: (machineId, target, options = {}) => {
      if (target.kind === "app" && target.window !== undefined) requireWindows();
      return mutate({
        type: "computer.view.open",
        machineId,
        target: ComputerViewTargetSchema.parse(target),
        idempotencyKey: options.idempotencyKey ?? `view-open:${crypto.randomUUID()}`,
      });
    },
    closeComputerView: (viewId, generation, options = {}) =>
      mutate({
        type: "computer.view.close",
        viewId,
        generation,
        idempotencyKey: options.idempotencyKey ?? `view-close:${viewId}:${generation}`,
      }),
    renewComputerView: (viewId, generation, options = {}) =>
      renew(viewId, generation, options.idempotencyKey ?? `view-renew:${crypto.randomUUID()}`),
    listComputerAppWindows: async (machineId, app) => {
      requireWindows();
      const started = authority();
      const result = unwrapRpcResult(await rpc["computer.app.windows"]({ machineId, app }));
      requireAuthority(started);
      return result.windows;
    },
    listApprovedComputerApps: async () => {
      const started = authority();
      const result = unwrapRpcResult(await rpc["integration.computer.apps.approved"]({}));
      requireAuthority(started);
      return result.apps;
    },
  };
}
