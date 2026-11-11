/* Failure modes: rows name the device the reader is at, or name devices in a list with one;
 * a phone's row names itself twice; the device filter offers nothing to narrow, lets an
 * Opensteer App through, counts ignoring the rest of the filter, drops a chosen device that
 * merely has no rows, or keeps narrowing to a device that left the Deployment while a tab it
 * kept still lists it; a label changes identity, redrawing its row, when its device did not. */
import { describe, expect, it } from "vitest";
import type { MachineSummary } from "@opensteer/protocol";
import type { PlaceItem } from "./places.js";
import {
  allTabs,
  devicesElsewhere,
  placeDeviceLabels,
  sameDevicesElsewhere,
  tabDeviceChoice,
  tabListHomeId,
  tabMatchesFilter,
} from "./tab-list.js";

const machine = (id: string, name: string, status: MachineSummary["status"] = "online") =>
  ({ id, name, status, device: { form: "laptop", platform: "macos" } }) as MachineSummary;
const machines = [
  machine("mini", "Mac mini"),
  machine("studio", "Studio Mac", "offline"),
  machine("pixel", "Pixel 8"),
];
const nameOf = (id: string) => machines.find((value) => value.id === id)?.name ?? id;
const place = (
  key: string,
  device: string | null,
  kind: PlaceItem["kind"] = "browser",
  busy = false,
): PlaceItem =>
  ({
    key,
    kind,
    identity: null,
    device: device ? { machineId: device, name: nameOf(device) } : null,
    occupants: busy ? [{ threadId: "t", holding: true, acting: true, lastActiveAt: "" }] : [],
  }) as unknown as PlaceItem;

const places = [
  place("a", "mini", "browser", true),
  place("b", "studio"),
  place("c", "studio", "app", true),
  place("phone", "pixel", "phone"),
  place("budget", null, "opensteer-app"),
];

describe("the device each row names", () => {
  it("names devices only once the list spans two, never the reader's own, and never a phone's own row", () => {
    const away = devicesElsewhere(machines, null);
    expect(placeDeviceLabels(places.slice(1, 3), away).size).toBe(0);
    const labels = placeDeviceLabels(places, devicesElsewhere(machines, "mini"));
    expect([...labels.keys()]).toEqual(["b", "c"]);
    expect(labels.get("b")).toMatchObject({ name: "Studio Mac", online: false });
    // One label per device: rows on it share it.
    expect(labels.get("c")).toBe(labels.get("b"));
    // A reader at none of the devices hears every one named, until one is home.
    expect([...placeDeviceLabels(places, away).keys()]).toEqual(["a", "b", "c"]);
  });

  it("keeps its labels while their devices read the same, and changes them when one does not", () => {
    const before = devicesElsewhere(machines, "mini");
    // A machine's computer use and sessions change often; its name, shape and presence rarely.
    const busier = machines.map((value) => ({ ...value, computerUse: null }) as MachineSummary);
    expect(sameDevicesElsewhere(before, devicesElsewhere(busier, "mini"))).toBe(true);
    const renamed = machines.map((value) =>
      value.id === "studio" ? { ...value, name: "Studio" } : value,
    );
    expect(sameDevicesElsewhere(before, devicesElsewhere(renamed, "mini"))).toBe(false);
    const woke = machines.map((value) =>
      value.id === "studio" ? ({ ...value, status: "online" } as MachineSummary) : value,
    );
    expect(sameDevicesElsewhere(before, devicesElsewhere(woke, "mini"))).toBe(false);
  });

  it("is home, for a reader at no device, at the computer that runs the Deployment", () => {
    const main = {
      ...machine("mini", "Mac mini"),
      ownership: "deployment",
      allowedModules: ["agents"],
    } as MachineSummary;
    const snapshot = {
      can: null,
      deploymentShape: null,
      machines: [main, ...machines.slice(1)],
    };
    expect(tabListHomeId(snapshot, null)).toBe("mini");
    expect(tabListHomeId(snapshot, "studio")).toBe("studio");
    expect(tabListHomeId({ ...snapshot, machines: [] }, null)).toBeNull();
    const home = tabListHomeId(snapshot, null);
    expect([
      ...placeDeviceLabels(places, devicesElsewhere(snapshot.machines, home)).keys(),
    ]).toEqual(["b", "c"]);
  });
});

describe("narrowing the list to one device", () => {
  it("offers nothing while every row runs on one device", () => {
    const choice = tabDeviceChoice({
      places: [places[1]!, places[2]!, places[4]!],
      machines,
      hereId: null,
      homeId: null,
      filter: allTabs,
    });
    expect(choice.devices).toEqual([]);
  });

  it("lists devices home first, then by name, counted under the rest of the filter", () => {
    const filter = { ...allTabs, agents: true };
    const choice = tabDeviceChoice({
      places,
      machines,
      hereId: "studio",
      homeId: "studio",
      filter,
    });
    expect(choice.devices.map(({ id, here, count }) => [id, here, count])).toEqual([
      ["studio", true, 1],
      ["mini", false, 1],
      ["pixel", false, 0],
    ]);
    expect(choice.filter).toBe(filter);
  });

  it("leaves out what runs on no device, as an Opensteer App does", () => {
    const pixel = { ...allTabs, device: "pixel" };
    expect(places.filter((value) => tabMatchesFilter(value, pixel)).map(({ key }) => key)).toEqual([
      "phone",
    ]);
  });

  it("keeps a chosen device with no rows offered, and forgets one that left the Deployment", () => {
    const kept = tabDeviceChoice({
      places: [places[0]!],
      machines,
      hereId: null,
      homeId: null,
      filter: { ...allTabs, device: "studio" },
    });
    expect(kept.filter.device).toBe("studio");
    expect(kept.devices.map(({ id, count }) => [id, count])).toEqual([
      ["mini", 1],
      ["studio", 0],
    ]);
    // A saved tab can outlive the computer it ran on; the computer still narrows nothing.
    const gone = tabDeviceChoice({
      places: [...places, place("kept", "removed")],
      machines,
      hereId: null,
      homeId: null,
      filter: { ...allTabs, agents: true, device: "removed" },
    });
    expect(gone.filter).toEqual({ ...allTabs, agents: true });
    expect(gone.devices.map(({ id }) => id)).toEqual(["mini", "pixel", "studio"]);
  });
});
