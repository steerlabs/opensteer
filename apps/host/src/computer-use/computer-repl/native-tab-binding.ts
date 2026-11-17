import { refused, OpensteerError, type Blocked, type TabId, type UserId } from "@opensteer/core";
import { computerConnectionDeviceId, type DeviceComputerConnection } from "../device-drivers.js";
import type { DeviceId, RunnerId } from "@opensteer/core";
import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import { ComputerUseTabBindingSchema } from "@opensteer/protocol";
import { computerAppIdentitiesEqual } from "@opensteer/integration-core";
import type { TabServicePort } from "../../tabs/ports.js";
import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import type { NativeReplTabTarget } from "../native-tab-targets.js";
import { ComputerUseError } from "../computer-use-service.js";
import type { ReplReply } from "./messages.js";

export interface NativeTabBindingOptions {
  selfDeviceId(runnerId: RunnerId): Promise<DeviceId>;
  tabs: Pick<TabServicePort, "get" | "authorizeShow">;
  lookup(ownerId: UserId, tabId: TabId): Promise<NativeReplTabTarget>;
  connections(): Promise<readonly DeviceComputerConnection[]>;
  blocked?(target: NativeReplTabTarget): Promise<Blocked | undefined>;
  bind(
    connection: DeviceComputerConnection,
    target: NativeReplTabTarget,
    beforeAcquired: () => Promise<void>,
  ): Promise<ReplReply>;
}
export async function bindNativeTab(
  options: NativeTabBindingOptions,
  claims: RunToolScope,
  tabId: TabId,
): Promise<ReplReply> {
  let expected: NativeReplTabTarget | undefined;
  const authorize = async () => {
    await options.tabs.authorizeShow(claims, tabId);
    if (!expected) return;
    const current = await options.lookup(claims.requestedBy, tabId);
    if (
      current.tabGeneration !== expected.tabGeneration ||
      current.kind !== expected.kind ||
      current.computerId !== expected.computerId ||
      (current.kind === "phone" &&
        expected.kind === "phone" &&
        current.driverGeneration !== expected.driverGeneration) ||
      (current.kind === "window" &&
        expected.kind === "window" &&
        current.windowId !== expected.windowId)
    )
      throw refused("conflict", "This tab changed while binding.");
  };
  await authorize();
  const tab = await options.tabs.get(claims.requestedBy, tabId);
  if (tab.kind !== "window" && tab.kind !== "phone")
    throw new ComputerUseError(
      "unsupported",
      tab.kind === "page"
        ? "Use Browser Harness openPage(tabId) for page tabs."
        : "Use app tools and the app's localUrl for app tabs.",
    );
  const target = await options.lookup(claims.requestedBy, tabId);
  expected = target;
  if (target.kind !== tab.kind || target.computerId !== tab.computer.computerId)
    throw refused("not_found", "This tab is unavailable.");
  const connection = (await options.connections()).find(
    (entry) =>
      entry.computer !== null &&
      computerConnectionDeviceId(entry) === target.computerId &&
      (target.kind === "phone"
        ? isPhoneDisplayDefinitionId(entry.definitionId)
        : entry.computer.app && computerAppIdentitiesEqual(entry.computer.app, target.app)),
  );
  const blocked = await options.blocked?.(target);
  if (blocked)
    throw new OpensteerError({
      code: "forbidden",
      reason: blocked.code,
      message: blocked.message,
      next: blocked.next,
    });
  if (!connection) throw refused("not_found", "This tab is unavailable.");
  await authorize();
  const reply = await options.bind(connection, target, authorize);
  await authorize();
  const value = reply.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.tabId !== tabId)
    throw refused("conflict", "This tab changed while binding.");
  const window = value.window;
  const binding =
    target.kind === "window" && window && typeof window === "object" && !Array.isArray(window)
      ? {
          kind: "window",
          connectionId: connection.id,
          tabId,
          window: { windowId: window.windowId, title: window.title, ref: window.ref },
        }
      : {
          kind: "phone",
          connectionId: connection.id,
          tabId,
          name: tab.title,
          computerId: target.computerId,
        };
  return { ...reply, value: ComputerUseTabBindingSchema.parse(binding) };
}
