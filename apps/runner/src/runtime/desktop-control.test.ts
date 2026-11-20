import { expect, it } from "vitest";
import { holdDesktopRunnerIdle, startDesktopRunnerControl } from "./desktop-control.js";

it("atomically grants an idle hold and releases it if an update is abandoned", async () => {
  let idle = false;
  const control = await startDesktopRunnerControl(() => idle);
  try {
    expect(await holdDesktopRunnerIdle(control.ready)).toBeNull();
    expect(control.held()).toBe(false);
    idle = true;
    const release = await holdDesktopRunnerIdle(control.ready);
    expect(release).not.toBeNull();
    expect(control.held()).toBe(true);
    expect(await holdDesktopRunnerIdle(control.ready)).toBeNull();
    await release?.();
    expect(control.held()).toBe(false);
  } finally {
    control.close();
  }
});
