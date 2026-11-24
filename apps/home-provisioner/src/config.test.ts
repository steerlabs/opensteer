import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { loadConfig } from "./config.js";

const provisionerKey = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");

const google = {
  OPENSTEER_ACCOUNT_URL: "https://account.test",
  OPENSTEER_HOME_CLOUDFLARE_TOKEN: "cloudflare_token_for_tests",
  OPENSTEER_HOME_CLOUDFLARE_ZONE_ID: "0".repeat(32),
  OPENSTEER_HOME_CLOUD_COMPUTER_DOMAIN: "computers.example.test",
  OPENSTEER_HOME_GCP_PROJECT: "test-project",
  OPENSTEER_HOME_GCP_ZONE: "us-central1-a",
  OPENSTEER_HOME_GCP_NETWORK: "home-net",
  OPENSTEER_HOME_GCP_SUBNET: "home-subnet",
};
const pool = {
  OPENSTEER_POOL_PROVISIONER_KEY: provisionerKey,
  OPENSTEER_POOL_HOME_CIDR: "10.40.0.0/20",
  OPENSTEER_POOL_PROVISIONER_CIDR: "10.50.0.0/24",
};

it("refuses to start without the browser pool, since every Cloud Computer's browser runs there", () => {
  expect(() => loadConfig(google)).toThrow(
    "Cloud Computers need the browser pool: set OPENSTEER_POOL_PROVISIONER_KEY",
  );
  // The key alone is not the pool: its two address ranges are required with it.
  expect(() => loadConfig({ ...google, OPENSTEER_POOL_PROVISIONER_KEY: provisionerKey })).toThrow(
    "OPENSTEER_POOL_HOME_CIDR",
  );
  // The Homes' subnet is the one network each Home's firewall opens: never a public or wider one.
  for (const cidr of ["0.0.0.0/0", "8.8.8.0/24", "10.128.0.1/20"])
    expect(() => loadConfig({ ...google, ...pool, OPENSTEER_POOL_HOME_CIDR: cidr })).toThrow(
      "OPENSTEER_POOL_HOME_CIDR",
    );
  expect(loadConfig({ ...google, ...pool }).pool).toMatchObject({
    homeCidr: "10.40.0.0/20",
    provisionerCidr: "10.50.0.0/24",
  });
});

it("gives a Cloud Computer a 4 GB e2-medium by default, its browser being in the pool", () => {
  expect(loadConfig({ ...google, ...pool })).toMatchObject({
    region: "us-central1-a",
    serverType: "e2-medium",
    diskType: "pd-balanced",
    diskSizeGb: 30,
  });
  expect(
    loadConfig({ ...google, ...pool, OPENSTEER_HOME_GCP_MACHINE_TYPE: "e2-standard-8" }).serverType,
  ).toBe("e2-standard-8");
  const { OPENSTEER_HOME_CLOUD_COMPUTER_DOMAIN: _required, ...withoutDomain } = google;
  expect(() => loadConfig({ ...withoutDomain, ...pool })).toThrow(
    "OPENSTEER_HOME_CLOUD_COMPUTER_DOMAIN",
  );
});
