/**
 * The one-off split of builds stored with their framework inlined. A separate entry so data-step
 * hosts that share code with browser bundles do not import the workerd runtime.
 */
export {
  BuildSplitOutcome,
  splitInlinedWorkerBuild,
  type BuildSplit,
  type FrameworkLabelSource,
} from "./implementation/worker-build-migration.ts";
