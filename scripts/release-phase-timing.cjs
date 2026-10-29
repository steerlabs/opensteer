const { appendFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");

// Shared by TypeScript builders and electron-builder's CommonJS hooks. Only
// static phase identifiers enter the recorder; never command arguments/output.
function startPhase(phase) {
  if (!/^(?:package|runtime)\.[a-z0-9.-]+$/.test(phase))
    throw Error("Invalid release phase identifier");
  const filename = process.env.OPENSTEER_RELEASE_TIMING_FILE;
  const id = randomUUID();
  const started = performance.now();
  const record = (event) => {
    if (filename)
      appendFileSync(
        filename,
        JSON.stringify({
          id,
          parentId: process.env.OPENSTEER_RELEASE_COMMAND_ID,
          phase,
          event,
          at: new Date().toISOString(),
          elapsedMs: performance.now() - started,
        }) + "\n",
        { mode: 0o600 },
      );
  };
  record("start");
  return (event = "complete") => record(event);
}
async function timePhase(phase, work) {
  const finish = startPhase(phase);
  try {
    const result = await work();
    finish();
    return result;
  } catch (error) {
    finish("failed");
    throw error;
  }
}
module.exports = { startPhase, timePhase };
