import { test } from "node:test";
import assert from "node:assert/strict";
import { assertForkSafe } from "./fork-safety.mjs";
test("rejects every privileged workflow surface", () => {
  for (const text of [
    "${{ secrets.KEY }}",
    "on: pull_request_target",
    "id-token: write",
    "runs-on: [self-hosted, linux]",
    "environment: production",
    "environments: {}",
  ])
    assert.throws(() => assertForkSafe(text));
});
test("read-only hosted SHA-pinned workflow accepted", () =>
  assert.doesNotThrow(() =>
    assertForkSafe("permissions:\n  contents: read\nruns-on: ubuntu-24.04\n"),
  ));
test("quoted YAML keys and bracketed secret expressions are rejected", () => {
  for (const text of ['${{ secrets["KEY"] }}', '"id-token": "write"', '"environment": production'])
    assert.throws(() => assertForkSafe(text));
});

test("rejects workflow and job write permissions, including write-all", () => {
  for (const text of [
    "permissions: write-all",
    "permissions: { contents: write }",
    "jobs: { build: { permissions: { packages: write } } }",
    "permissions: { checks: write, contents: read }",
    'permissions: { contents: "${{ inputs.permission }}" }',
  ])
    assert.throws(() => assertForkSafe(text));
});
test("checkout requires explicit static false credential persistence", () => {
  const checkout = "uses: actions/checkout@" + "a".repeat(40);
  for (const settings of [
    "",
    "\n  with: { persist-credentials: true }",
    '\n  with: { persist-credentials: "${{ inputs.persist }}" }',
  ])
    assert.throws(() => assertForkSafe(`steps:\n- ${checkout}${settings}\n`));
  for (const value of ["false", '"false"'])
    assert.doesNotThrow(() =>
      assertForkSafe(`steps:\n- ${checkout}\n  with: { persist-credentials: ${value} }\n`),
    );
});
test("only an explicitly reviewed scope can allow a write permission", () => {
  assert.doesNotThrow(() =>
    assertForkSafe("permissions: { contents: write }", { allowedWriteScopes: ["contents"] }),
  );
  assert.throws(() =>
    assertForkSafe("permissions: { packages: write }", { allowedWriteScopes: ["contents"] }),
  );
  assert.throws(() =>
    assertForkSafe("permissions: write-all", { allowedWriteScopes: ["contents"] }),
  );
});
test("workflow guard follows nested local composites and rejects their unsafe settings", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { checkWorkflows } = await import("./fork-safety.mjs");
  const root = mkdtempSync(join(tmpdir(), "fork-safety-"));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  try {
    write(
      ".github/workflows/ci.yml",
      "permissions: {contents: read}\njobs:\n  build:\n    steps:\n      - uses: ./.github/actions/setup\n",
    );
    write(
      ".github/actions/setup/action.yml",
      "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/browser\n",
    );
    const action = ".github/actions/browser/action.yaml";
    for (const unsafe of [
      "uses: actions/setup-node@main",
      'run: echo "${{ secrets.KEY }}"',
      "uses: actions/checkout@" + "b".repeat(40) + "\n      with: { persist-credentials: true }",
      "permissions: write-all",
    ]) {
      write(action, `runs:\n  using: composite\n  steps:\n    - ${unsafe}\n`);
      assert.throws(() => checkWorkflows([".github/workflows/ci.yml"], { root }), unsafe);
    }
    write(
      action,
      "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@" +
        "b".repeat(40) +
        "\n      with: {persist-credentials: false}\n",
    );
    assert.equal(checkWorkflows([".github/workflows/ci.yml"], { root }).length, 3);
    rmSync(join(root, action));
    assert.throws(() => checkWorkflows([".github/workflows/ci.yml"], { root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
