const { startPhase, timePhase } = require("../../../scripts/release-phase-timing.cjs");
module.exports = async (context) => {
  globalThis.opensteerCollectTiming = startPhase("package.collect-asar");
  if (process.env.OPENSTEER_RELEASE_TIMING_FILE && context.electronPlatformName === "darwin") {
    const sign = context.packager.doSign.bind(context.packager);
    context.packager.doSign = (...args) => timePhase("package.electron-sign", () => sign(...args));
  }
};
