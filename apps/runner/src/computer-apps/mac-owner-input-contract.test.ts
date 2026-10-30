import { describe, expect, it } from "vitest";
import {
  ComputerUseHelloParamsSchema,
  ComputerUseHelloResultSchema,
  ComputerUsePermissionsResultSchema,
  HostIntegrationsDisplayResolveSchema,
  macWindowVideoParams,
  macWindowVideoResults,
  RunnerIntegrationsModuleSchema,
} from "@opensteer/protocol";

const source = {
  kind: "owner-view",
  viewId: "cvw_01900000-0000-7000-8000-000000000001",
  generation: 1,
};
const streamId = "dsp_01900000-0000-7000-8000-000000000001";

describe("Mac owner input contract", () => {
  it("offers optional input without changing baseline hello", () => {
    const baseline = { protocolVersion: 10, clientVersion: "test" };
    expect(ComputerUseHelloParamsSchema.parse(baseline)).toEqual(baseline);
    expect(
      ComputerUseHelloParamsSchema.safeParse({ ...baseline, ownerInputVersion: 1 }).success,
    ).toBe(true);
    expect(
      ComputerUseHelloParamsSchema.safeParse({ ...baseline, ownerInputVersion: 2 }).success,
    ).toBe(true);
    expect(ComputerUseHelloResultSchema.shape.ownerInputVersion.safeParse(undefined).success).toBe(
      true,
    );
  });
  it("reads legacy peer input negotiation as unsupported", () => {
    expect(ComputerUseHelloResultSchema.shape.ownerInputVersion.parse(1)).toBeUndefined();
    expect(ComputerUsePermissionsResultSchema.shape.ownerInputVersion.parse(1)).toBeUndefined();
    expect(HostIntegrationsDisplayResolveSchema.shape.ownerInputVersion.parse(1)).toBeUndefined();
    expect(ComputerUseHelloParamsSchema.shape.ownerInputVersion.parse(1)).toBeUndefined();
    expect(macWindowVideoParams["display.resolve"].parse({ source, ownerInputVersion: 1 })).toEqual(
      { source, ownerInputVersion: undefined },
    );
  });
  it("advertises Runner input independently of passive video", () => {
    expect(RunnerIntegrationsModuleSchema.shape.macOwnerInputVersion.safeParse(1).success).toBe(
      true,
    );
    expect(RunnerIntegrationsModuleSchema.shape.macOwnerInputVersion.parse(1)).toBeUndefined();
  });
  it("requires exact owner authority and per-batch generation without a control lease", () => {
    const input = {
      streamId,
      source,
      geometry: 1,
      sequence: 0,
      events: [{ kind: "copy" }],
    };
    expect(macWindowVideoParams["display.input"].safeParse(input).success).toBe(true);
    expect(macWindowVideoParams["display.input"].safeParse({ ...input, geometry: 0 }).success).toBe(
      false,
    );
    expect(
      macWindowVideoResults["display.input"].safeParse({
        sequence: 0,
        outcome: "stale",
        reason: "stale",
      }).success,
    ).toBe(true);
  });
  it("admits bounded rich-paste metadata for the text-only target to refuse", () => {
    const input = {
      streamId,
      source,
      geometry: 1,
      sequence: 1,
      events: [{ kind: "paste", items: [{ type: "image/png", size: 64 }] }],
    };
    expect(macWindowVideoParams["display.input"].safeParse(input).success).toBe(true);
    expect(
      macWindowVideoParams["display.input"].safeParse({
        ...input,
        events: [{ kind: "paste", items: [{ type: "image/png", size: 16 * 1024 * 1024 + 1 }] }],
      }).success,
    ).toBe(false);
    expect(
      macWindowVideoResults["display.input"].safeParse({
        sequence: 1,
        outcome: "refused",
        reason: "unsupported",
      }).success,
    ).toBe(true);
  });
});
