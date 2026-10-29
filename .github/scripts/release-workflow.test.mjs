import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseDocument } from "yaml";

const text = readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8");
const doc = parseDocument(text, { uniqueKeys: true });
const workflow = doc.toJS();

test("desktop release accepts only namespaced tags and opt-in manual publishing", () => {
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push, { tags: ["desktop-v*.*.*", "v*.*.*-insider"] });
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ["stable", "beta"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(workflow.concurrency.group, /^release-desktop-/);
});

test("release authority is scoped, environment gated, pinned and isolated from PRs", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(text, /pull_request_target|OPENSTEER_DESKTOP_UPDATE_FEED_URL/);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(["ubuntu-latest", "macos-15"].includes(job["runs-on"]));
    assert.deepEqual(job.permissions ?? workflow.permissions, {
      contents: ["draft", "publish"].includes(name) ? "write" : "read",
    });
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with["persist-credentials"], false);
      }
      if (JSON.stringify(step).includes("secrets.")) assert.equal(job.environment, "release");
      assert.doesNotMatch(step.run ?? "", /\$\{\{\s*(inputs\.|github\.ref)/);
    }
  }
  assert.equal(workflow.jobs.build.environment, "release");
  assert.equal(workflow.jobs.publish.environment, "release");
  assert.match(workflow.jobs.publish.if, /inputs.publish/);
  assert.match(workflow.jobs.publish.if, /needs.draft.result == 'success'/);
  assert.match(workflow.jobs.preflight.steps[1].run, /git merge-base --is-ancestor/);
});

test("preflight rejects malformed versions and cross-channel suffixes before secrets", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = workflow.jobs.preflight.steps[1].run;
  const validation = script.slice(script.indexOf("stable="), script.indexOf("manifest_version="));
  for (const [channel, version, accepted] of [
    ["stable", "1.2.3", true],
    ["beta", "1.2.3-beta.1", false],
    ["stable", "1.2.3-beta.1", false],
    ["beta", "1.2.3", true],
    ["beta", "1.2.3-beta.01", false],
    ["stable", "01.2.3", false],
    ["beta", "1.2.3-rc.1", false],
    ["other", "1.2.3", false],
  ]) {
    const result = spawnSync("bash", ["-e", "-c", validation], {
      env: { ...process.env, CHANNEL: channel, VERSION: version },
    });
    assert.equal(result.status === 0, accepted, `${channel} ${version}`);
  }
});
