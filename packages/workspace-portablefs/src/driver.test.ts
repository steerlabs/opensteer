import type { PortableFsWorkspaceBacking, Workspace } from "@opensteer/core";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { PortableFsControlPlane } from "./control-plane.js";
import { PortableFsWorkspaceLifecycleDriver } from "./driver.js";
import {
  PortableFsManagerCapacitySchema,
  PortableFsVolumeIdSchema,
  type PortableFsManagerVolume,
} from "./schemas.js";

const serviceId = "test-portablefs";
const volumeId = PortableFsVolumeIdSchema.parse("123e4567-e89b-42d3-a456-426614174000");
const cellId = "11111111-1111-4111-8111-111111111111";
const liveCapacityResponse = {
  pools: [
    {
      archived_volumes: 0,
      capacity_bytes: 40_000_000_000,
      capacity_inodes: 2_000_000,
      create_admissible: true,
      measured_used_bytes: 52_047_872,
      measured_used_inodes: 1_970,
      pending_bytes: 0,
      pending_inodes: 0,
      placements: 9,
      pool: "product",
      restore_admissible: false,
    },
  ],
};

function volume(
  state: PortableFsManagerVolume["state"],
  fields: Partial<PortableFsManagerVolume> = {},
): PortableFsManagerVolume {
  const now = Math.floor(Date.now() / 1_000);
  return {
    authorization_domain: "opensteer-installation",
    authority_endpoint: "authority.internal:7443",
    authority_generation: 3,
    created_unix: now,
    id: volumeId,
    owner: "usr_owner",
    placement: {
      authority_id: "authority-1",
      authority_server_name: "authority.internal",
      cell_id: cellId,
      created_unix: now,
      listen_port: 7443,
      prior_strict_mounts_fenced: false,
      project_id: 42,
      sequence: 1,
      service_gid: 42,
      service_uid: 42,
    },
    placement_sequence: 1,
    pool: "product",
    product_issuer: "opensteer",
    product_public_key_pem: "test-product-public-key",
    quota_bytes: 100 * 1024 * 1024,
    quota_inodes: 100_000,
    state,
    updated_unix: now,
    ...fields,
  };
}

function controlPlane(state: PortableFsManagerVolume["state"]): PortableFsControlPlane {
  const reject = () => Promise.reject(new Error("not used by the lifecycle driver"));
  return {
    advanceRenewalFences: reject,
    archiveVolume: () => Promise.resolve(volume(state)),
    capacity: () => Promise.resolve(PortableFsManagerCapacitySchema.parse(liveCapacityResponse)),
    createVolume: () => Promise.resolve(volume(state)),
    destroyVolume: () => Promise.resolve({ id: volumeId, state: "DESTROYED" }),
    getVolume: () => Promise.resolve(volume(state)),
    health: () => Promise.resolve({ releaseId: "manager-test" }),
    issueAutomaticMountGrant: reject,
    issueReadSessionGrant: reject,
    revokeMountEnrollment: reject,
    wakeVolume: () => Promise.resolve(volume(state)),
  };
}

function workspace(): Workspace & { readonly backing: PortableFsWorkspaceBacking } {
  const now = new Date().toISOString();
  return {
    backing: { generation: 1, kind: "portablefs", serviceId, volumeId },
    capacityPolicy: {
      blockHardLimitBytes: 512 * 1_024 * 1_024,
      inodeHardLimit: 50_000,
      kind: "hard-quota",
    },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "main",
    name: "Main",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function driverFor(state: PortableFsManagerVolume["state"]): PortableFsWorkspaceLifecycleDriver {
  return new PortableFsWorkspaceLifecycleDriver({ controlPlane: controlPlane(state), serviceId });
}

describe("PortableFsWorkspaceLifecycleDriver.inspect", () => {
  it.each([
    ["READY", "ready"],
    ["PROVISIONING", "provisioning"],
    ["FENCING", "unavailable"],
    ["ARCHIVING", "archiving"],
    ["ARCHIVED", "archived"],
    ["QUARANTINED", "failed"],
    ["RETIRED", "failed"],
    ["DESTROYED", "failed"],
  ] as const)("maps the known Manager state %s to %s", async (state, status) => {
    await expect(driverFor(state).inspect(workspace())).resolves.toEqual({ issue: null, status });
  });

  it.each([
    [undefined, "provisioning"],
    ["placing", "provisioning"],
    ["restoring-namespace", "provisioning"],
    ["serving-restore", "ready"],
    ["converged", "ready"],
  ] as const)("maps RESTORING step %s to %s", async (restoreStep, status) => {
    const getVolume = async () =>
      volume("RESTORING", {
        restore_progress_permille: 425,
        ...(restoreStep === undefined ? {} : { restore_step: restoreStep }),
      });
    const driver = new PortableFsWorkspaceLifecycleDriver({
      controlPlane: { ...controlPlane("READY"), getVolume },
      serviceId,
    });

    await expect(driver.inspect(workspace())).resolves.toEqual({
      issue: null,
      restoreProgressPermille: 425,
      status,
    });
  });

  // An archive cycle in flight is not an archive: nothing is sealed until the
  // Manager reports ARCHIVED, and reporting `archived` early would promise a
  // sealed archive that cannot be read.
  it.each(["quiesce", "export", "verify", "seal"] as const)(
    "keeps an ARCHIVING cycle at step %s out of archived",
    async (archiveCycleStep) => {
      const getVolume = async () => volume("ARCHIVING", { archive_cycle_step: archiveCycleStep });
      const driver = new PortableFsWorkspaceLifecycleDriver({
        controlPlane: { ...controlPlane("READY"), getVolume },
        serviceId,
      });

      await expect(driver.inspect(workspace())).resolves.toEqual({
        issue: null,
        status: "archiving",
      });
    },
  );

  it("holds an unknown Manager state at a retryable unavailable, never terminal", async () => {
    const health = await driverFor("HIBERNATING").inspect(workspace());
    expect(health.status).toBe("unavailable");
    expect(health.issue).toMatchObject({
      code: "manager-unknown-volume-state",
      retryable: true,
    });
    expect(health.issue?.message).toContain("HIBERNATING");
  });

  it("provisions against an unknown or archived state without failing the Workspace", async () => {
    const input = { idempotencyKey: "idem-1", workspace: workspace() };
    await expect(driverFor("HIBERNATING").provision(input)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(driverFor("ARCHIVED").provision(input)).resolves.toMatchObject({
      status: "archived",
    });
  });
});

describe("PortableFsWorkspaceLifecycleDriver.provision", () => {
  it("passes the persisted per-Workspace quota to volume creation", async () => {
    const current = workspace();
    const pending = {
      ...current,
      backing: { ...current.backing, volumeId: `pending_${current.id}` as never },
      capacityPolicy: {
        blockHardLimitBytes: 20 * 1_024 * 1_024 * 1_024,
        inodeHardLimit: 2_000_000,
        kind: "hard-quota" as const,
      },
    };
    const createVolume = vi.fn(async () => volume("READY"));
    const driver = new PortableFsWorkspaceLifecycleDriver({
      controlPlane: { ...controlPlane("READY"), createVolume },
      serviceId,
    });

    await driver.provision({ idempotencyKey: "quota-override", workspace: pending });

    expect(createVolume).toHaveBeenCalledWith(
      {
        owner: current.createdBy,
        quotaBytes: 20 * 1_024 * 1_024 * 1_024,
        quotaInodes: 2_000_000,
      },
      { idempotencyKey: "quota-override" },
    );
  });
});

describe("PortableFsWorkspaceLifecycleDriver.admitsCreates", () => {
  it("parses the live Manager capacity shape and admits product creates", async () => {
    const report = PortableFsManagerCapacitySchema.parse(liveCapacityResponse);
    const driver = new PortableFsWorkspaceLifecycleDriver({
      controlPlane: { ...controlPlane("READY"), capacity: async () => report },
      serviceId,
    });

    await expect(driver.admitsCreates()).resolves.toBe(true);
  });

  it("uses the Manager product-pool admission verdict", async () => {
    const capacity = vi.fn(async () => ({
      pools: [
        {
          archived_volumes: 1,
          capacity_bytes: 100,
          capacity_inodes: 10,
          create_admissible: false,
          measured_used_bytes: 90,
          measured_used_inodes: 8,
          pending_bytes: 10,
          pending_inodes: 2,
          placements: 2,
          pool: "product",
          restore_admissible: false,
        },
      ],
    }));
    const driver = new PortableFsWorkspaceLifecycleDriver({
      controlPlane: { ...controlPlane("READY"), capacity },
      serviceId,
    });

    await expect(driver.admitsCreates()).resolves.toBe(false);
    expect(capacity).toHaveBeenCalledWith({ timeoutMs: 5_000 });
  });

  it("treats an unrecognized capacity report as advisory failure", async () => {
    const driver = new PortableFsWorkspaceLifecycleDriver({
      controlPlane: { ...controlPlane("READY"), capacity: async () => ({ pools: [] }) },
      serviceId,
    });

    await expect(driver.admitsCreates()).rejects.toThrow(/omitted the product pool/u);
  });
});

describe("PortableFsWorkspaceLifecycleDriver.destroy", () => {
  it("destroys the bound volume with one stable idempotency key", async () => {
    const destroyVolume = vi.fn<PortableFsControlPlane["destroyVolume"]>(async () => ({
      id: volumeId,
      state: "DESTROYED",
    }));
    const control = { ...controlPlane("READY"), destroyVolume };
    const driver = new PortableFsWorkspaceLifecycleDriver({ controlPlane: control, serviceId });

    await driver.destroy({ workspace: workspace() });

    expect(destroyVolume).toHaveBeenCalledWith(volumeId, {
      idempotencyKey: expect.stringContaining(":destroy:v1"),
    });
  });
});
