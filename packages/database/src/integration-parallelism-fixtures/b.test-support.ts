import { databaseJourney } from "./journey.test-support.js";
if (process.env.OPENSTEER_PARALLELISM_FIXTURE_SCENARIO?.startsWith("artifacts-")) {
  const { artifactJourney } = await import("./artifacts.test-support.js");
  artifactJourney("b");
} else databaseJourney("b");
