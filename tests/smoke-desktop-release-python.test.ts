import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  observerPythonFlags,
  resolveObserverPython,
} from "../scripts/smoke-desktop-release-python.js";

it("resolves the concrete interpreter and refuses relative paths and the developer-tool shim", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "observer-python-test-"));
  try {
    const executable = path.join(directory, "concrete-python");
    await writeFile(executable, "fixture");
    const alias = path.join(directory, "python3");
    await symlink(executable, alias);
    expect(await resolveObserverPython({ OPENSTEER_RELEASE_OBSERVER_PYTHON: alias })).toBe(
      await realpath(executable),
    );
    await expect(
      resolveObserverPython({ OPENSTEER_RELEASE_OBSERVER_PYTHON: "python3" }),
    ).rejects.toThrow(/absolute/);
    await expect(
      resolveObserverPython({ OPENSTEER_RELEASE_OBSERVER_PYTHON: "/usr/bin/python3" }),
    ).rejects.toThrow(/shim/);
    expect(observerPythonFlags).toEqual(["-I", "-S", "-u"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
