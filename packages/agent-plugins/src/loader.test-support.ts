import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotLocalServerPackage, type LocalServerPackageRegistration } from "./loader.js";

/** A source folder for one test, and a registration of it into a package beside it. */
export async function fixture(
  work: (
    root: string,
    load: (
      registration: LocalServerPackageRegistration,
    ) => ReturnType<typeof snapshotLocalServerPackage>,
  ) => Promise<void>,
) {
  const base = await mkdtemp(join(tmpdir(), "opensteer-local-package-"));
  const root = join(base, "source");
  await mkdir(root);
  try {
    await work(root, (registration) =>
      snapshotLocalServerPackage({
        pluginId: "fixture",
        directory: root,
        dataDirectory: join(base, "data"),
        registration,
      }),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
