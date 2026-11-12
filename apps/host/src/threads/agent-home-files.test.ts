import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { AgentHomeFiles } from "./agent-home-files.js";

it("lists, previews and downloads Agent home through the real native helper", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "host-agent-home-files-")));
  const files = new AgentHomeFiles({
    agentHome: async () => ({ computerId: createId("runner"), path }),
    helperPath: fileURLToPath(
      new URL("../../../runner/native-fs-helper/opensteer-native-fs", import.meta.url),
    ),
  });
  try {
    await writeFile(join(path, "note.txt"), "Folder content");
    const page = await files.list({ parentKey: "", limit: 20 });
    expect(page.entries).toMatchObject([{ name: "note.txt", kind: "file" }]);
    const key = page.entries[0]!.key;
    expect((await files.preview(key)).bytes.toString()).toBe("Folder content");
    expect(await (await files.download(key)).text()).toBe("Folder content");
  } finally {
    files.close();
    await rm(path, { recursive: true, force: true });
  }
});
