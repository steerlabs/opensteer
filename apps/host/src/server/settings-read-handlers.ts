import type { UserId } from "@opensteer/core";
import {
  hostApi,
  rpcSuccess,
  type HostApiHandlers,
  type MachineSummary,
  type OtherDevice,
} from "@opensteer/protocol";
import { requireSession } from "./rpc-context.js";

export function createSettingsReadHandlers(options: {
  readonly otherDevices: (
    owner: UserId,
    machines: readonly MachineSummary[],
  ) => Promise<readonly OtherDevice[]>;
  readonly machines: HostApiHandlers["machines.list"];
}): Pick<HostApiHandlers, "devices.overview.get"> {
  return {
    "devices.overview.get": async (_input, context) => {
      const owner = requireSession(context).user.id;
      const result = await options.machines({}, context);
      if (!result.ok) return result;
      return rpcSuccess(
        hostApi["devices.overview.get"].success.parse({
          devices: result.data.machines,
          otherDevices: await options.otherDevices(owner, result.data.machines),
        }),
      );
    },
  };
}
