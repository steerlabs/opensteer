import path from "node:path";
import { z } from "zod";
import { acquireReleaseLock } from "../command-runner.js";
import { journeyWorkDirectory } from "./work-directory.js";
import { pruneCompletedBuild } from "./build-cleanup.js";
const revisions = z
  .array(z.string().regex(/^[a-f0-9]{40}$/u))
  .nonempty()
  .parse(process.argv.slice(2));
for (const revision of revisions)
  for (const channel of ["stable", "beta"]) {
    const directory = path.join(journeyWorkDirectory(), "builds", revision, channel);
    const unlock = await acquireReleaseLock(path.join(directory, "build.lock"));
    try {
      console.log(JSON.stringify(await pruneCompletedBuild(directory)));
    } finally {
      await unlock();
    }
  }
