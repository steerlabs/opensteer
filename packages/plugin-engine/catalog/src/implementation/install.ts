/** What a host's copy of an official app's prepared snapshot returns. */
import { Effect } from "effect";
import type { App, DeployedApp } from "@opensteer/plugin-engine-sdk";

/**
 * `apps.copy` of a snapshot with `activation: "deploy"` deploys it and returns the deployed app;
 * its `App` type covers copies of unfinished apps too.
 */
export const deployedCopy = ({ activeVersion, ...app }: App): Effect.Effect<DeployedApp> =>
  activeVersion === null
    ? Effect.die(new Error("A deployed copy has no active version"))
    : Effect.succeed({ ...app, activeVersion });
