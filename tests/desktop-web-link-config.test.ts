import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { z } from "zod";
const config = z.object({
  protocols: z.array(z.object({ schemes: z.array(z.string()) })),
  mac: z.object({
    protocols: z.array(z.object({ schemes: z.array(z.string()), role: z.string().optional() })),
  }),
});
it.each(["electron-builder.yml", "electron-builder.beta.yml"])(
  "%s adds web schemes only to macOS alongside OAuth",
  (name) => {
    const base = z
      .object({ mac: z.record(z.string(), z.unknown()) })
      .parse(parse(readFileSync("apps/desktop/electron-builder.base.yml", "utf8")));
    const channel = z
      .object({ protocols: z.unknown() })
      .passthrough()
      .parse(parse(readFileSync(`apps/desktop/${name}`, "utf8")));
    const merged = config.parse({
      ...base,
      ...channel,
      mac: { ...base.mac, ...(channel.mac as object) },
    });
    expect([...merged.protocols, ...merged.mac.protocols].flatMap((p) => p.schemes)).toEqual(
      expect.arrayContaining(["http", "https", ...merged.protocols.flatMap((p) => p.schemes)]),
    );
    expect(merged.mac.protocols.find((p) => p.schemes.includes("https"))?.role).toBe("Viewer");
    expect(merged.protocols.flatMap((p) => p.schemes)).not.toContain("https");
  },
);
