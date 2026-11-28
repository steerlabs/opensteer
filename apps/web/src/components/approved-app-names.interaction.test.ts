// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovedComputerApp } from "@opensteer/protocol";
import { useApprovedAppNames, type ApprovedAppNamesHost } from "@opensteer/client/react";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => document.body.replaceChildren());

const mac = "dev_00000000-0000-4000-8000-0000000000d1";
const target = (bundleId: string) => ({
  grant: {
    kind: "computer-app" as const,
    approvalId: "con_00000000-0000-4000-8000-0000000000c1",
    deviceId: mac,
    app: { kind: "mac-app" as const, bundleId, teamId: null },
  },
});
const approved = (bundleId: string, name: string) =>
  ({
    connectionId: "con_00000000-0000-4000-8000-0000000000c1",
    machineId: mac,
    target: { kind: "app", app: { bundleId, displayName: name, teamId: null } },
    name,
    iconPng: null,
  }) as ApprovedComputerApp;

describe("the approved app names a client shows", () => {
  it("are read once for every view that shows them, and again only for an app not yet named", async () => {
    const read = vi.fn(async () => ({
      ok: true as const,
      data: { apps: [approved("com.apple.Safari", "Safari")] },
    }));
    const client = {
      rpc: { "integration.computer.apps.approved": read },
    } as unknown as ApprovedAppNamesHost;
    const seen: (string | undefined)[] = [];
    function View({ bundleIds }: { readonly bundleIds: readonly string[] }) {
      const names = useApprovedAppNames(client, bundleIds.map(target));
      seen.push(names?.get(`${mac}\ncom.apple.safari`));
      return null;
    }
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const render = (bundleIds: readonly string[]) =>
      act(async () =>
        root.render(
          createElement("div", null, [
            createElement(View, { key: "activity", bundleIds }),
            createElement(View, { key: "now", bundleIds }),
          ]),
        ),
      );
    await render(["com.apple.Safari"]);
    // Two views, one read; both show the name.
    expect(read).toHaveBeenCalledOnce();
    expect(seen.at(-1)).toBe("Safari");
    // The same apps shown again, as after a machine's routine change: nothing more is read.
    await render(["com.apple.Safari"]);
    expect(read).toHaveBeenCalledOnce();
    // An app with no approved name is asked for once, never again while it is shown.
    await render(["com.apple.Safari", "com.example.Unapproved"]);
    await render(["com.apple.Safari", "com.example.Unapproved"]);
    expect(read).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });
});
