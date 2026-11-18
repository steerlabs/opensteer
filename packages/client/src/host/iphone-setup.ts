import { classifyClientFailure } from "../connections/operation-error.js";
import { operationFailure } from "./operation-failure.js";
import { DesktopIphoneSetupReasonSchema } from "@opensteer/protocol/desktop";
import {
  IphoneScreenAttachResultSchema,
  type IphoneScreenAttachCommand,
  type IphoneScreenDetachCommand,
  IphoneScreenDetachResultSchema,
} from "@opensteer/protocol";
import type {
  DesktopIphoneSetupBridge,
  DesktopIphoneSetupStatus,
} from "@opensteer/protocol/desktop";
export interface IphoneSetupPort extends DesktopIphoneSetupBridge {
  remove(input: Parameters<DesktopIphoneSetupBridge["detach"]>[0]): Promise<{ pending: boolean }>;
  attach(input: { setupId: string; name?: string }): Promise<DesktopIphoneSetupStatus>;
}
export function createIphoneSetupPort(
  platform: DesktopIphoneSetupBridge,
  dispatch: (command: IphoneScreenAttachCommand | IphoneScreenDetachCommand) => Promise<unknown>,
): IphoneSetupPort {
  const inFlight = new Map<string, Promise<DesktopIphoneSetupStatus>>();
  const orchestrate = (setupId: string, prepare: () => Promise<DesktopIphoneSetupStatus>) => {
    const previous = inFlight.get(setupId);
    if (previous) return previous;
    const work = (async () => {
      const status = await prepare();
      if (status.reason || !status.attachCommand) return status;
      let result;
      try {
        result = IphoneScreenAttachResultSchema.parse(await dispatch(status.attachCommand));
      } catch (error) {
        const classified = classifyClientFailure(error);
        const reason = DesktopIphoneSetupReasonSchema.safeParse(
          classified.reason === "unsupported-version"
            ? "host-version-unsupported"
            : classified.reason,
        );
        return platform.failed({
          setupId,
          reason: reason.success
            ? reason.data
            : operationFailure(error) === "unavailable"
              ? "host-offline"
              : "attach-failed",
        });
      }
      return platform.complete({ setupId, result });
    })();
    inFlight.set(setupId, work);
    void work
      .finally(() => {
        if (inFlight.get(setupId) === work) inFlight.delete(setupId);
      })
      .catch(() => undefined);
    return work;
  };
  return {
    ...platform,
    retry: ({ setupId }) => orchestrate(setupId, () => platform.retry({ setupId })),
    remove: async (input) => {
      const pending = await platform.detach(input);
      let result;
      try {
        result = IphoneScreenDetachResultSchema.parse(await dispatch(pending.command));
      } catch {
        return { pending: true };
      }
      if (result.deviceId !== input.deviceId) return { pending: true };
      await platform.completeDetach({
        deploymentId: input.deploymentId,
        idempotencyKey: pending.command.idempotencyKey,
        result,
      });
      return { pending: false };
    },
    attach: ({ setupId, name }) =>
      orchestrate(setupId, () =>
        platform.add({ setupId, ...(name === undefined ? {} : { name }) }),
      ),
  };
}
