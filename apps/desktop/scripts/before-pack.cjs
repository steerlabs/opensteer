const { startPhase } = require("../../../scripts/release-phase-timing.cjs");
module.exports = async () => {
  globalThis.opensteerCollectTiming = startPhase("package.collect-asar");
};
