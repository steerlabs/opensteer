import { describe, expect, it } from "vitest";
import {
  nodeTrustEnvironment,
  nodeTrustSetting,
  nodeTrustVariable,
} from "../deploy/container/opensteer-node-trust.mjs";

describe("what a Home service or Runner trusts", () => {
  it("adds the computer's certificates unless the setting turns them off", () => {
    for (const environmentInputs of ["drop", "keep"] as const) {
      expect(
        nodeTrustEnvironment({ HOME: "/home/person" }, { environmentInputs, settings: {} }),
      ).toEqual({ HOME: "/home/person", NODE_USE_SYSTEM_CA: "1" });
      // Only the one word turns it off; anything else leaves it on.
      expect(
        nodeTrustEnvironment(
          { HOME: "/home/person" },
          { environmentInputs, settings: { [nodeTrustSetting]: "no" } },
        ),
      ).toEqual({ HOME: "/home/person", NODE_USE_SYSTEM_CA: "1" });
    }
  });

  it("drops every trust input whatever its case, as Windows reads names", () => {
    expect(
      nodeTrustEnvironment(
        {
          HOME: "/home/person",
          node_extra_ca_certs: "/tmp/root.pem",
          Node_Options: "--use-openssl-ca",
          node_use_system_ca: "0",
          OpenSSL_Conf: "/tmp/openssl.cnf",
          ssl_cert_dir: "/tmp/certs",
          Ssl_Cert_File: "/tmp/cert.pem",
        },
        { environmentInputs: "drop", settings: {} },
      ),
    ).toEqual({ HOME: "/home/person", NODE_USE_SYSTEM_CA: "1" });
  });

  it("turned off, trusts Node's own list only, and a Linux operator's extra root still counts", () => {
    const settings = { [nodeTrustSetting]: "off" };
    expect(
      nodeTrustEnvironment(
        { HOME: "/home/person", NODE_EXTRA_CA_CERTS: "/tmp/root.pem", NODE_USE_SYSTEM_CA: "1" },
        { environmentInputs: "drop", settings },
      ),
    ).toEqual({ HOME: "/home/person" });
    expect(
      nodeTrustEnvironment(
        { NODE_EXTRA_CA_CERTS: "/home-proof-account-ca.pem", node_use_system_ca: "1" },
        { environmentInputs: "keep", settings },
      ),
    ).toEqual({ NODE_EXTRA_CA_CERTS: "/home-proof-account-ca.pem" });
  });

  it("reads the setting from this process's own environment when no other is given", () => {
    const previous = process.env[nodeTrustSetting];
    process.env[nodeTrustSetting] = "off";
    try {
      expect(nodeTrustEnvironment({}, { environmentInputs: "drop" })).toEqual({});
    } finally {
      if (previous === undefined) delete process.env[nodeTrustSetting];
      else process.env[nodeTrustSetting] = previous;
    }
    expect(nodeTrustEnvironment({}, { environmentInputs: "drop", settings: {} })).toEqual({
      [nodeTrustVariable]: "1",
    });
  });
});
