import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { maximumLocalServerFolderFiles, readVerifiedPluginSnapshot } from "./loader.js";
import { fixture } from "./loader.test-support.js";

// Writes, reads and verifies over 30,000 real files, which takes the integration lane's time.
test("a folder of the most files a folder may hold registers with its registration file", async () =>
  fixture(async (root, load) => {
    await Promise.all(
      Array.from({ length: maximumLocalServerFolderFiles }, (_, index) =>
        writeFile(join(root, `f${index}`), ""),
      ),
    );
    const plugin = await load({ name: "example", launch: { command: "node" } });
    expect(
      await readVerifiedPluginSnapshot(plugin.root, plugin.root.split("/").at(-1)!),
    ).toHaveLength(maximumLocalServerFolderFiles + 1);
    await writeFile(join(root, "one-more"), "");
    await expect(load({ name: "example", launch: { command: "node" } })).rejects.toThrow(
      "installation limit",
    );
  }));
