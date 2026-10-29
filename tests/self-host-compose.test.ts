import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("self-host Compose contract", () => {
  it("publishes the Host public key through the PortableFS Files trust volume", async () => {
    const [baseSource, overlaySource] = await Promise.all([
      readFile(resolve("deploy/self-host/compose.yaml"), "utf8"),
      readFile(resolve("deploy/self-host/compose.portablefs.yaml"), "utf8"),
    ]);
    const base: unknown = parse(baseSource, { logLevel: "silent" });
    const overlay: unknown = parse(overlaySource, { logLevel: "silent" });

    expect(base).toMatchObject({
      services: {
        host: {
          environment: {
            OPENSTEER_HOST_PRIVATE_KEY_PATH: "/var/lib/opensteer/keys/host-private.pem",
          },
        },
      },
    });
    expect(overlay).toMatchObject({
      services: {
        files: {
          command: expect.arrayContaining([
            "--request-public-key",
            "/request-trust/host-public.pem",
          ]),
          volumes: expect.arrayContaining(["browser-trust:/request-trust:ro"]),
        },
        host: {
          environment: {
            OPENSTEER_HOST_PUBLIC_KEY_PATH: "/var/lib/opensteer-public/host-public.pem",
          },
          volumes: expect.arrayContaining(["browser-trust:/var/lib/opensteer-public"]),
        },
      },
      volumes: { "browser-trust": {} },
    });
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
