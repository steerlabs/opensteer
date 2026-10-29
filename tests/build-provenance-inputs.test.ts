import { expect, test } from "vitest";
import { builderSchema } from "../scripts/component-provenance.mjs";

test("public image provenance validates the supplied GCP project without pinning a deployment", () => {
  const builder = {
    kind: "google-cloud-build",
    project: "example-build-project",
    buildId: "11111111-1111-4111-8111-111111111111",
    sourceRevision: "a".repeat(40),
    configPath: "build/container.yaml",
  };
  expect(builderSchema.parse(builder)).toEqual(builder);
  for (const project of ["", "bad project", "../project", "123bad"])
    expect(builderSchema.safeParse({ ...builder, project }).success).toBe(false);
});
