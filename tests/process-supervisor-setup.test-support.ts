import { processSupervisorExecutableVariable } from "../packages/shared/src/processControl.js";
import { builtProcessSupervisor } from "./process-supervisor.test-support.js";

// Every engine and program child runs under the native supervisor, in tests as in the app. A test
// that spawns one fails naming this path until `pnpm --filter @opensteer/desktop
// build:process-supervisor` has built it; tests that spawn nothing need no build.
process.env[processSupervisorExecutableVariable] = builtProcessSupervisor;
