import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { describe, expect, it } from "vitest";
import { createSelectionFile } from "./selection-file.js";

const filePath = "/private/selection.json";
const open = () => {
  const privateFiles = new MemoryPrivateFilesystem();
  return { privateFiles, selection: createSelectionFile({ filePath, privateFiles }) };
};

describe("createSelectionFile", () => {
  it("distinguishes a new phone from an explicit choice to stay on the list", async () => {
    const { selection } = open();

    expect(await selection.read()).toBeUndefined();

    await selection.write(null);

    expect(await selection.read()).toBeNull();
  });

  it("opens on the list rather than failing when the preference is unreadable", async () => {
    const { privateFiles, selection } = open();
    privateFiles.put(filePath, "{not json");

    expect(await selection.read()).toBeNull();

    privateFiles.put(filePath, JSON.stringify({ selectedDeploymentId: "not-an-id" }));

    expect(await selection.read()).toBeNull();
  });
});
