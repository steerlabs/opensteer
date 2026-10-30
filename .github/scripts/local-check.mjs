import { decide } from "./ci-changes.mjs";
/**
 * The changed-file slice of CI. A global or unknown input still makes CI run
 * everything (`full`), but locally it only widens typecheck to every workspace:
 * GitHub `Check` owns builds and full suites, so repeating them here only delays
 * a push.
 */
export function localPlan(files, graph, present, baseGraph = graph) {
  const plan = decide(files, graph, baseGraph);
  const code = present.filter((p) => /\.[cm]?[jt]sx?$/.test(p));
  const tests = present.filter(
    (p) =>
      /\.test\.[cm]?[jt]sx?$/.test(p) &&
      (files.includes(p) ||
        // Any extension: a data file such as tests/quarantine.json selects its validator.
        files.some((f) => p.startsWith(f.replace(/\.[^./]+$/, "") + "."))),
  );
  const existing = files.filter((p) => present.includes(p));
  const commands = [];
  if (existing.length)
    commands.push(["exec", "prettier", "--check", "--ignore-unknown", "--", ...existing]);
  const changedCode = code.filter((p) => files.includes(p));
  if (changedCode.length)
    commands.push(
      ["exec", "oxlint", "--deny-warnings", ...changedCode],
      [
        "exec",
        "oxlint",
        "-A",
        "all",
        "--type-aware",
        "-W",
        "typescript/no-floating-promises",
        "-D",
        "typescript/no-misused-promises",
        ...changedCode,
      ],
    );
  if (plan.affected.length)
    commands.push(
      [...plan.affected.flatMap((n) => ["--filter", n]), "--if-present", "typecheck"],
      ["typecheck:tests"],
    );
  // Root test files belong to no workspace package; only typecheck:tests covers them.
  else if (files.some((p) => /^tests\/.*\.test\.tsx?$/.test(p))) commands.push(["typecheck:tests"]);
  const ordinary = tests.filter(
    (p) => !/\.(integration|gui|engine|device|soak)\.test\./.test(p) && !/\.test\.[cm]js$/.test(p),
  );
  const integration = tests.filter((p) => /\.integration\.test\./.test(p));
  const gui = tests.filter((p) => /\.gui\.test\./.test(p));
  if (ordinary.length) commands.push(["pretest"], ["exec", "vitest", "run", ...ordinary]);
  if (integration.length) commands.push(["test:integration", "--", ...integration]);
  if (gui.length) commands.push(["test:vm", "--", "pnpm", "test:gui", "--", ...gui]);
  if (files.some((p) => p.startsWith("apps/agent-phone/")))
    commands.push([
      "--dir",
      "apps/agent-phone",
      "exec",
      "./gradlew",
      ":app:lint",
      ":app:testDebugUnitTest",
      ":app:assembleDebug",
      ":fixture:assembleDebug",
      "--no-daemon",
    ]);
  if (files.some((p) => p.startsWith("apps/desktop/native/")))
    commands.push(
      ["--filter", "@opensteer/desktop", "build:computer-use-helper"],
      ["--filter", "@opensteer/desktop", "build:passwords-broker"],
    );
  const nodeTests = tests.filter((p) => /\.test\.[cm]js$/.test(p));
  if (nodeTests.length) commands.push(["exec", "node", "--test", ...nodeTests]);
  return { ...plan, tests, commands };
}
