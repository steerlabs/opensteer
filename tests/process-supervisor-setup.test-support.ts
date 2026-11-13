import { existsSync } from "node:fs";
import { processSupervisorExecutableVariable } from "../packages/shared/src/processControl.js";
import { builtProcessSupervisor } from "./process-supervisor.test-support.js";

// Every engine and program child runs under the native supervisor, in tests as in the app.
if (!existsSync(builtProcessSupervisor))
  throw new Error(
    `${builtProcessSupervisor} is missing. Build it with \`pnpm --filter @opensteer/desktop build:process-supervisor\`.`,
  );
process.env[processSupervisorExecutableVariable] = builtProcessSupervisor;
