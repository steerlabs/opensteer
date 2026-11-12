import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { FolderAdmissionService } from "./folder-admission-service.js";
import { FolderFilesService } from "./folder-files-service.js";

it("lists, previews and downloads an admitted folder through the real native helper", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "host-folder-files-")));
  const computerId = createId("runner");
  const folder = { computerId, path };
  const admission = new FolderAdmissionService({
    hostingComputerId: computerId,
    ownerId: createId("user"),
    environmentId: createId("environment"),
    agentHome: folder,
    assertOwner: async () => undefined,
  });
  const files = new FolderFilesService({
    admit: (chosen) => admission.admit(chosen),
    helperPath: fileURLToPath(
      new URL("../../../runner/native-fs-helper/opensteer-native-fs", import.meta.url),
    ),
  });
  try {
    await writeFile(join(path, "note.txt"), "Folder content");
    const page = await files.list(folder, { parentKey: "", limit: 20 });
    expect(page.entries).toMatchObject([{ name: "note.txt", kind: "file" }]);
    const key = page.entries[0]!.key;
    expect((await files.preview(folder, key)).bytes.toString()).toBe("Folder content");
    expect(await (await files.download(folder, key)).text()).toBe("Folder content");
  } finally {
    files.close();
    await rm(path, { recursive: true, force: true });
  }
});
