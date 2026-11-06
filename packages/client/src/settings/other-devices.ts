import type { OtherDevice, PluginRow } from "@opensteer/protocol";

/** What a device under "Other devices" says, and where tapping it goes. */
export interface OtherDeviceLine {
  readonly detail: string;
  readonly tone: "ok" | "muted" | "attention";
  readonly opens:
    | { readonly kind: "task"; readonly threadId: string }
    | { readonly kind: "plugin"; readonly pluginId: string };
}

/**
 * The row for one device a plugin controls. While its setup task waits on the
 * person or its server is not running, the row leads to the task that set it
 * up; otherwise it leads to the plugin's own page. `taskNeedsYou` is whether
 * that task has a pending Request, which the caller reads from its threads.
 */
export function otherDeviceLine(device: OtherDevice, taskNeedsYou: boolean): OtherDeviceLine {
  const plugin = { kind: "plugin", pluginId: device.pluginId } as const;
  const task = device.setupThreadId
    ? ({ kind: "task", threadId: device.setupThreadId } as const)
    : null;
  if (taskNeedsYou && task) return { detail: "Needs you", tone: "attention", opens: task };
  if (device.computer && device.computer.status !== "online") {
    return { detail: `Waiting for ${device.computer.name}`, tone: "muted", opens: plugin };
  }
  if (device.issue) return { detail: device.issue, tone: "attention", opens: task ?? plugin };
  return {
    detail: device.computer ? `via ${device.computer.name}` : "Connected",
    tone: "ok",
    opens: plugin,
  };
}

/** Plugins listed on the Plugins page: a plugin that declares a device is listed under Devices. */
export function pluginsPageRows(rows: readonly PluginRow[]): readonly PluginRow[] {
  return rows.filter((row) => !row.device);
}

/** The first words of the task "Connect something else" starts; the person finishes the sentence. */
export const connectDeviceDraftText = "Connect my ";

/** The task Fix starts for a device; the agent finds the plugin by its id. */
export function fixDeviceDraftText(device: { readonly name: string; readonly pluginId: string }) {
  return `${device.name} isn't working. Fix its plugin, ${device.pluginId}.`;
}
