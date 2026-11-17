import type { WebContents, WebFrameMain } from "electron";
import {
  DesktopIphoneSetupBeginSchema,
  DesktopIphoneDetachInputSchema,
  DesktopIphoneDetachCompleteSchema,
  DesktopIphoneDetachStatusSchema,
  DesktopIphoneSetupChooseSchema,
  DesktopIphoneSetupAddSchema,
  DesktopIphoneSetupHelpSchema,
  DesktopIphoneSetupCompleteSchema,
  DesktopIphoneSetupFailureSchema,
  DesktopIphoneSetupIdSchema,
  DesktopIphoneSetupStatusSchema,
  DesktopIphoneSetupWifiSchema,
  DesktopIphoneWifiInputSchema,
  DesktopIphoneConfigureWifiSchema,
  DesktopIphoneWifiStatusSchema,
  type DesktopIphoneSetupStatus,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import type { IphoneMapping } from "../../iphone/iphone-store.js";
import { IphoneServiceError } from "../../iphone/iphone-store.js";

type Owner = {
  frame: WebFrameMain;
  sender: WebContents;
  deploymentId: string;
  targetKey: string;
  cancel(): void;
  unsubscribe?: () => void;
};
export function iphoneHandlers(context: DesktopBridgeContext): {
  handlers: ReadonlyArray<readonly [string, DesktopBridgeHandler]>;
  dispose(): void;
} {
  const owners = new Map<string, Owner>();
  const pending = new Map<
    WebContents,
    {
      frame: WebFrameMain;
      deploymentId: string;
      targetKey: string;
      work: Promise<DesktopIphoneSetupStatus>;
    }
  >();
  let beginTail: Promise<unknown> = Promise.resolve();
  const port = context.options.iphone;
  const cancel = (id: string) => {
    const owner = owners.get(id);
    if (!owner) return;
    owners.delete(id);
    owner.unsubscribe?.();
    owner.sender.removeListener("destroyed", owner.cancel);
    owner.sender.removeListener("did-start-navigation", owner.cancel);
    void port?.setup.cancel(id).catch(() => undefined);
  };
  const owned = (id: string, frame: WebFrameMain | null): Owner => {
    const owner = owners.get(id);
    if (
      !owner ||
      owner.frame !== frame ||
      context.options.access.snapshot().selectedDeploymentId !== owner.deploymentId
    )
      throw new IphoneServiceError("cancelled");
    const current = port?.service.ownerForSlot(owner.deploymentId);
    if (!current) throw new IphoneServiceError("runner-not-enrolled");
    return owner;
  };
  const unsubscribeAccess = context.options.access.subscribe((snapshot) => {
    for (const [id, owner] of owners)
      if (snapshot.selectedDeploymentId !== owner.deploymentId) cancel(id);
  });
  const handler =
    (fn: DesktopBridgeHandler): DesktopBridgeHandler =>
    async (event, envelope) => {
      assertAuthorizedRenderer(context, event, envelope);
      if (!port || !port.service.supported || !event.senderFrame)
        throw new IphoneServiceError("unsupported-mac");
      return fn(event, envelope);
    };
  const detachStatus = (record: IphoneMapping) =>
    DesktopIphoneDetachStatusSchema.parse({
      pending: true,
      command: {
        type: "iphone.screen.detach",
        idempotencyKey: record.detachKey,
        deviceId: record.deviceId,
        expectedGeneration: record.driverGeneration,
      },
    });
  const slotOwner = (deploymentId: string) => {
    if (context.options.access.snapshot().selectedDeploymentId !== deploymentId)
      throw new IphoneServiceError("cancelled");
    return port!.service.ownerForSlot(deploymentId);
  };
  return {
    handlers: [
      [
        desktopBridgeChannels.iphoneWifiStatus,
        handler(async (_event, envelope) => {
          const input = DesktopIphoneWifiInputSchema.parse(envelope.input);
          return DesktopIphoneWifiStatusSchema.parse(
            await port!.service.wifiStatus(slotOwner(input.deploymentId), input.deviceId),
          );
        }),
      ],
      [
        desktopBridgeChannels.iphoneConfigureWifi,
        handler(async (event, envelope) => {
          const input = DesktopIphoneConfigureWifiSchema.parse(envelope.input);
          const owner = slotOwner(input.deploymentId);
          const controller = new AbortController();
          const abort = () => controller.abort();
          event.sender.once("destroyed", abort);
          event.sender.once("did-start-navigation", abort);
          const unsubscribe = context.options.access.subscribe((snapshot) => {
            if (snapshot.selectedDeploymentId !== input.deploymentId) abort();
          });
          try {
            return DesktopIphoneWifiStatusSchema.parse(
              await port!.service.configureWifi(
                owner,
                input.deviceId,
                input.action,
                controller.signal,
              ),
            );
          } finally {
            unsubscribe();
            event.sender.removeListener("destroyed", abort);
            event.sender.removeListener("did-start-navigation", abort);
          }
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupWifi,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupWifiSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          return port!.setup.wifi(input.setupId, input.choice);
        }),
      ],
      [
        desktopBridgeChannels.iphoneDetach,
        handler(async (_event, envelope) => {
          const input = DesktopIphoneDetachInputSchema.parse(envelope.input);
          return detachStatus(
            await port!.service.detach(slotOwner(input.deploymentId), input.deviceId),
          );
        }),
      ],
      [
        desktopBridgeChannels.iphoneDetachComplete,
        handler(async (_event, envelope) => {
          const input = DesktopIphoneDetachCompleteSchema.parse(envelope.input);
          await port!.service.confirmDetach(
            slotOwner(input.deploymentId),
            input.result.deviceId,
            input.idempotencyKey,
          );
        }),
      ],
      [
        desktopBridgeChannels.iphonePendingDetaches,
        handler((_event, envelope) => {
          const input = DesktopIphoneSetupBeginSchema.parse(envelope.input);
          return port!.service.pendingDetaches(slotOwner(input.deploymentId)).map(detachStatus);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupBegin,
        handler(async (event, envelope) => {
          const { deploymentId, target } = DesktopIphoneSetupBeginSchema.parse(envelope.input);
          if (context.options.access.snapshot().selectedDeploymentId !== deploymentId)
            throw new IphoneServiceError("cancelled");
          const targetKey = JSON.stringify(target ?? null);
          const previous = pending.get(event.sender);
          if (
            previous &&
            previous.frame === event.senderFrame &&
            previous.deploymentId === deploymentId &&
            previous.targetKey === targetKey
          )
            return previous.work;
          for (const [id, owner] of owners)
            if (
              owner.sender === event.sender &&
              owner.frame === event.senderFrame &&
              owner.deploymentId === deploymentId &&
              owner.targetKey === targetKey
            )
              return port!.setup.status(id);
          for (const [id, owner] of owners) if (owner.sender === event.sender) cancel(id);
          const frame = event.senderFrame!;
          const onNavigate = () => {
            pending.delete(event.sender);
          };
          event.sender.once("destroyed", onNavigate);
          event.sender.once("did-start-navigation", onNavigate);
          const work = beginTail
            .catch(() => undefined)
            .then(async () => {
              try {
                if (pending.get(event.sender) !== marker) throw new IphoneServiceError("cancelled");
                const state = await port!.setup.begin(
                  port!.service.ownerForSlot(deploymentId),
                  target,
                );
                if (
                  pending.get(event.sender) !== marker ||
                  event.sender.isDestroyed() ||
                  context.options.access.snapshot().selectedDeploymentId !== deploymentId
                ) {
                  await port!.setup.cancel(state.setupId);
                  throw new IphoneServiceError("cancelled");
                }
                const cancelOwner = () => cancel(state.setupId);
                owners.set(state.setupId, {
                  frame: event.senderFrame!,
                  sender: event.sender,
                  deploymentId,
                  targetKey,
                  cancel: cancelOwner,
                });
                event.sender.once("destroyed", cancelOwner);
                event.sender.once("did-start-navigation", cancelOwner);
                return DesktopIphoneSetupStatusSchema.parse(state);
              } finally {
                if (pending.get(event.sender) === marker) pending.delete(event.sender);
                event.sender.removeListener("destroyed", onNavigate);
                event.sender.removeListener("did-start-navigation", onNavigate);
              }
            });
          const marker = { frame, deploymentId, targetKey, work };
          pending.set(event.sender, marker);
          beginTail = work;
          return work;
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupChoose,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupChooseSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          return port!.setup.choose(input.setupId, input.candidateId);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupAdd,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupAddSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          return port!.setup.add(input.setupId, input.name);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupHelp,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupHelpSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          return port!.setup.help(input.setupId, input.action);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupRetry,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupIdSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          return port!.setup.retry(input.setupId);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupComplete,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupCompleteSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          return port!.setup.complete(input.setupId, input.result);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupFailed,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupFailureSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          return port!.setup.failed(input.setupId, input.reason);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupStatus,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupIdSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          return port!.setup.status(input.setupId);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupCancel,
        handler(async (event, envelope) => {
          const input = DesktopIphoneSetupIdSchema.parse(envelope.input);
          owned(input.setupId, event.senderFrame);
          cancel(input.setupId);
          await port!.setup.cancel(input.setupId);
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupSubscribe,
        handler((event, envelope) => {
          const input = DesktopIphoneSetupIdSchema.parse(envelope.input);
          const owner = owned(input.setupId, event.senderFrame);
          owner.unsubscribe?.();
          owner.unsubscribe = port!.setup.subscribe(input.setupId, (state) => {
            if (
              owners.get(input.setupId) !== owner ||
              owner.sender.isDestroyed() ||
              owner.sender.mainFrame !== owner.frame
            )
              return;
            owner.sender.send(
              desktopBridgeChannels.iphoneSetupChanged,
              DesktopIphoneSetupStatusSchema.parse(state),
            );
          });
        }),
      ],
      [
        desktopBridgeChannels.iphoneSetupUnsubscribe,
        handler((event, envelope) => {
          const input = DesktopIphoneSetupIdSchema.parse(envelope.input);
          const owner = owned(input.setupId, event.senderFrame);
          owner.unsubscribe?.();
          delete owner.unsubscribe;
        }),
      ],
    ],
    dispose: () => {
      unsubscribeAccess();
      pending.clear();
      for (const id of Array.from(owners.keys())) cancel(id);
    },
  };
}
