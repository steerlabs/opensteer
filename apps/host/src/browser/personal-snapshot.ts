export function createTabResourcesReader(
  tabs: Pick<import("../tabs/ports.js").TabServicePort, "bootstrap">,
  browser: (
    ownerId: import("@opensteer/core").UserId,
  ) => Promise<import("@opensteer/protocol").HostedBrowserBootstrap>,
) {
  return async (input: {
    ownerId: import("@opensteer/core").UserId;
    maxBytes: number;
  }): Promise<import("@opensteer/protocol").DeploymentSnapshot["resources"]> => {
    const capabilities = await browser(input.ownerId);
    const budget =
      input.maxBytes - Buffer.byteLength(JSON.stringify({ browser: capabilities, tabs: null }));
    const catalog = await tabs.bootstrap(input.ownerId, budget);
    return { tabs: catalog, browser: capabilities };
  };
}
