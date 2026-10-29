import { describe, expect, it } from "vitest";
import {
  localDeploymentManifestChanged,
  parseLocalPortableFsCommand,
  parseLocalPortableFsEndpointConfiguration,
  validatePortableFsSource,
  type LocalPortableFsDeployment,
} from "../scripts/portablefs-local.js";

describe("local PortableFS deployment", () => {
  it("uses a loopback-only local deployment by default", () => {
    expect(parseLocalPortableFsEndpointConfiguration({})).toEqual({
      authorityHost: "127.0.0.1",
      authorityPortEnd: 23_255,
      authorityPortStart: 23_000,
      bindAddress: "127.0.0.1",
      managerHost: "127.0.0.1",
      managerPort: 28_443,
    });
  });

  it("accepts explicit on-prem endpoints without changing the control contract", () => {
    expect(
      parseLocalPortableFsEndpointConfiguration({
        OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_HOST: "cell.internal.example",
        OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_END: "24127",
        OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_START: "24000",
        OPENSTEER_PORTABLEFS_LOCAL_BIND_ADDRESS: "10.20.30.40",
        OPENSTEER_PORTABLEFS_LOCAL_MANAGER_HOST: "manager.internal.example",
        OPENSTEER_PORTABLEFS_LOCAL_MANAGER_PORT: "24443",
      }),
    ).toEqual({
      authorityHost: "cell.internal.example",
      authorityPortEnd: 24_127,
      authorityPortStart: 24_000,
      bindAddress: "10.20.30.40",
      managerHost: "manager.internal.example",
      managerPort: 24_443,
    });
  });

  it("rejects ambiguous hosts, unsafe ranges, and implicit reset commands", () => {
    expect(() =>
      parseLocalPortableFsEndpointConfiguration({
        OPENSTEER_PORTABLEFS_LOCAL_MANAGER_HOST: "manager",
      }),
    ).toThrow(/fully qualified/);
    expect(() =>
      parseLocalPortableFsEndpointConfiguration({
        OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_END: "23000",
        OPENSTEER_PORTABLEFS_LOCAL_AUTHORITY_PORT_START: "22000",
      }),
    ).toThrow(/1 through 256/);
    expect(parseLocalPortableFsCommand([])).toBe("up");
    expect(() => parseLocalPortableFsCommand(["reset"])).toThrow(/up\|down\|status/);
  });

  it("persists a deployment identity added to an older local manifest", () => {
    const persisted = {
      authorityHost: "127.0.0.1",
      authorityPortEnd: 23_255,
      authorityPortStart: 23_000,
      bindAddress: "127.0.0.1",
      cellId: "cell-1",
      deploymentId: "",
      managerHost: "127.0.0.1",
      managerPort: 28_443,
      portableFsCommit: "commit-1",
      portableFsSourceDirectory: "/portablefs",
      schemaVersion: 1,
    } satisfies LocalPortableFsDeployment;

    expect(
      localDeploymentManifestChanged(persisted, {
        ...persisted,
        deploymentId: "deployment-1",
      }),
    ).toBe(true);
  });

  it("explains exactly how to supply a missing source checkout", async () => {
    await expect(validatePortableFsSource("/definitely/missing/portablefs")).rejects.toThrow(
      /clean sibling checkout.*OPENSTEER_PORTABLEFS_SOURCE_DIR/,
    );
  });
});
