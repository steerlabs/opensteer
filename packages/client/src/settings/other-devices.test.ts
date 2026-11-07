import { RunnerIdSchema, ThreadIdSchema } from "@opensteer/core";
import type { OtherDevice, PluginRow } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { otherDeviceLine, pluginsPageRows } from "./other-devices.js";

const setupThreadId = ThreadIdSchema.parse("thr_00000000-0000-4000-8000-0000000000d1");
const device = (change: Partial<OtherDevice> = {}): OtherDevice => ({
  pluginId: "living-room-tv",
  name: "Living room TV",
  kind: "tv",
  computer: {
    id: RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-0000000000d1"),
    name: "Mac mini",
    status: "online",
  },
  issue: null,
  setupThreadId,
  ...change,
});
const toTask = { kind: "task", threadId: setupThreadId };
const toPlugin = { kind: "plugin", pluginId: "living-room-tv" };

describe("otherDeviceLine", () => {
  it("names the computer it runs on and opens the plugin when it works", () => {
    expect(otherDeviceLine(device(), false)).toEqual({
      detail: "via Mac mini",
      tone: "ok",
      opens: toPlugin,
    });
    expect(otherDeviceLine(device({ computer: null }), false).detail).toBe("Connected");
  });

  it("sends the person to the setup task while it waits on them, ahead of everything else", () => {
    const offline = device({
      computer: { ...device().computer!, status: "offline" },
      issue: "Waiting for approval",
    });
    expect(otherDeviceLine(offline, true)).toEqual({
      detail: "Needs you",
      tone: "attention",
      opens: toTask,
    });
  });

  it("ignores a task that needs the person when there is no task to open", () => {
    expect(otherDeviceLine(device({ setupThreadId: null }), true).detail).toBe("via Mac mini");
  });

  it("waits quietly for an offline computer instead of reporting its server's issue", () => {
    const line = otherDeviceLine(
      device({ computer: { ...device().computer!, status: "offline" }, issue: "Not running" }),
      false,
    );
    expect(line).toEqual({ detail: "Waiting for Mac mini", tone: "muted", opens: toPlugin });
  });

  it("shows the server's issue and opens the task that can fix it, or the plugin without one", () => {
    expect(otherDeviceLine(device({ issue: "Waiting for approval" }), false)).toEqual({
      detail: "Waiting for approval",
      tone: "attention",
      opens: toTask,
    });
    expect(otherDeviceLine(device({ issue: "Crashed", setupThreadId: null }), false).opens).toEqual(
      toPlugin,
    );
  });
});

describe("pluginsPageRows", () => {
  it("leaves out plugins that declare a device, including older rows without the field", () => {
    const row = (title: string, change: Partial<PluginRow> = {}) =>
      ({ title, ...change }) as PluginRow;
    const rows = [
      row("Linear"),
      row("Living room TV", { device: { kind: "tv", name: "Living room TV" } }),
      row("Notes", { device: null }),
    ];
    expect(pluginsPageRows(rows).map((each) => each.title)).toEqual(["Linear", "Notes"]);
  });
});
