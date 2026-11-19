import { pluginIconsMaxRefs } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import type { HostClient } from "../host/client.js";
import { PluginIcons } from "./icons.js";

const ref = (index: number) => `r${String(index).padStart(42, "0")}`;
const image = (index: number) => `data:image/png;base64,${index}`;

function host(answer: (refs: string[]) => Promise<string[]>) {
  const calls: string[][] = [];
  const rpc = {
    "plugins.icons.get": async ({ refs }: { refs: string[] }) => {
      calls.push(refs);
      const known = await answer(refs);
      return {
        ok: true as const,
        data: { icons: known.map((key) => ({ ref: key, image: image(Number(key.slice(1))) })) },
      };
    },
  };
  return { calls, client: { rpc } as unknown as Pick<HostClient, "rpc"> };
}

describe("plugin icons", () => {
  it("reads every ref asked for in a turn together, a page per read, and keeps each image", async () => {
    const { calls, client } = host(async (refs) => refs.filter((key) => key !== ref(1)));
    const icons = new PluginIcons(client);
    const listener = vi.fn();
    const refs = Array.from({ length: pluginIconsMaxRefs + 1 }, (_, index) => ref(index));
    for (const key of refs) {
      icons.subscribe(key, listener);
      icons.request(key);
      icons.request(key);
    }
    await vi.waitFor(() => expect(icons.image(ref(pluginIconsMaxRefs))).toBeDefined(), {
      timeout: 1_000,
    });
    expect(calls).toEqual([refs.slice(0, pluginIconsMaxRefs), refs.slice(pluginIconsMaxRefs)]);
    expect(icons.image(ref(0))).toBe(image(0));
    expect(icons.image(ref(1))).toBeNull();
    expect(listener).toHaveBeenCalledTimes(refs.length);

    icons.request(ref(0));
    await Promise.resolve();
    expect(calls).toHaveLength(2);
  });

  it("asks again for a ref whose read failed or gave no image", async () => {
    let fail = true;
    const { calls, client } = host(async (refs) => {
      if (fail) throw new Error("disconnected");
      return refs;
    });
    const icons = new PluginIcons(client);
    const stop = icons.subscribe(ref(7), () => undefined);
    icons.request(ref(7));
    await vi.waitFor(() => expect(icons.image(ref(7))).toBeNull(), { timeout: 1_000 });

    fail = false;
    icons.request(ref(7));
    await vi.waitFor(() => expect(icons.image(ref(7))).toBe(image(7)), { timeout: 1_000 });
    expect(calls).toEqual([[ref(7)], [ref(7)]]);
    stop();
    expect(icons.image(ref(7))).toBe(image(7));
  });

  it("reads again once when asked during a read that then fails", async () => {
    let fail = true;
    const { calls, client } = host(async (refs) => {
      if (fail) {
        fail = false;
        throw new Error("disconnected");
      }
      return refs;
    });
    const icons = new PluginIcons(client);
    icons.subscribe(ref(3), () => undefined);
    icons.request(ref(3));
    await Promise.resolve();
    // The connection came back while the first read was still out.
    icons.request(ref(3));
    await vi.waitFor(() => expect(icons.image(ref(3))).toBe(image(3)), { timeout: 1_000 });
    expect(calls).toEqual([[ref(3)], [ref(3)]]);
  });

  it("keeps one read per ref when its rows change while a retry is out", async () => {
    const retry = Promise.withResolvers<string[]>();
    const answers = [async () => [], () => retry.promise];
    const { calls, client } = host(async (refs) => (answers.shift() ?? (async () => refs))());
    const icons = new PluginIcons(client);
    const first = icons.subscribe(ref(5), () => undefined);
    icons.request(ref(5));
    await vi.waitFor(() => expect(icons.image(ref(5))).toBeNull(), { timeout: 1_000 });
    icons.request(ref(5));
    await Promise.resolve();
    // Its row leaves and another shows it while that retry is still out.
    first();
    icons.subscribe(ref(5), () => undefined);
    icons.request(ref(5));
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    retry.resolve([]);
    await vi.waitFor(() => expect(icons.image(ref(5))).toBe(image(5)), { timeout: 1_000 });
    expect(calls).toHaveLength(3);
  });
});
