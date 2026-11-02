import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("self-host Compose contract", () => {
  it("keeps Host keys on its own data volume", async () => {
    const base = parse(await readFile(resolve("deploy/self-host/compose.yaml"), "utf8"));
    expect(base.services.host.environment).toMatchObject({
      OPENSTEER_HOST_PRIVATE_KEY_PATH: "/var/lib/opensteer/keys/host-private.pem",
      OPENSTEER_HOST_PUBLIC_KEY_PATH: "/var/lib/opensteer/keys/host-public.pem",
    });
    expect(base.services.files).toBeUndefined();
  });

  it("forwards the external-Runner declaration into Host", async () => {
    const compose: unknown = parse(
      await readFile(resolve("deploy/self-host/compose.yaml"), "utf8"),
    );
    expect(compose).toMatchObject({
      services: {
        host: {
          environment: {
            OPENSTEER_ACCEPTS_EXTERNAL_RUNNERS: "${OPENSTEER_ACCEPTS_EXTERNAL_RUNNERS:-false}",
          },
        },
      },
    });
  });
});
