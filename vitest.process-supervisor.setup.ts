import { statSync } from "node:fs";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
import { builtProcessSupervisor } from "./scripts/process-supervisor-path.js";

const supervisor = builtProcessSupervisor(import.meta.dirname);
if (!statSync(supervisor, { throwIfNoEntry: false })?.isFile())
  throw new Error(
    `${supervisor} is missing; build it with: pnpm --filter @opensteer/desktop build:process-supervisor`,
  );
process.env[processSupervisorExecutableVariable] = supervisor;
