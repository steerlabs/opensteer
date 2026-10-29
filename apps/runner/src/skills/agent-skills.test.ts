import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentCapabilityProfiles,
  agentToolDefinitions,
  skillsForCapabilityProfile,
  toolsForCapabilityProfile,
  type OpensteerAgentSkillName,
} from "@opensteer/agent-tools";
import { parseHarnessSkillMetadata, renderHarnessSkillCatalog } from "@opensteer/harness";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSkillPlan } from "./skill-plan.js";
import { loadAgentSkillBundle, planAgentSkills } from "./agent-skills.js";

const bundleDirectory = fileURLToPath(new URL("../../agent-skills", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Runner Agent Skills", () => {
  it("loads the shipped open-standard bundle and scopes it by capability profile", async () => {
    const bundle = await loadAgentSkillBundle(bundleDirectory);

    expect(skillNames(bundle, "main")).toEqual([
      "opensteer-specialization",
      "opensteer-integrations",
      "opensteer-computer-use",
      "opensteer-browser",
      "opensteer-computers",
      "opensteer-workspaces",
      "opensteer-threads",
      "opensteer-triggers",
    ]);
    expect(skillNames(bundle, "workspace")).toEqual([
      "opensteer-specialization",
      "opensteer-integrations",
      "opensteer-computer-use",
      "opensteer-browser",
      "opensteer-computers",
      "opensteer-threads",
      "opensteer-triggers",
    ]);
    expect(skillNames(bundle, "delegated")).toEqual([
      "opensteer-specialization",
      "opensteer-integrations",
      "opensteer-computer-use",
      "opensteer-browser",
      "opensteer-computers",
      "opensteer-threads",
      "opensteer-triggers",
    ]);
    expect(skillNames(bundle, "trigger")).toEqual(["opensteer-triggers"]);
    expect(
      planAgentSkills(bundle, "main").find(({ name }) => name === "opensteer-integrations")?.path,
    ).toBe(join(bundle.rootPath, "skills", "opensteer-integrations"));
    expect(skillNames(bundle, "main")).toEqual(skillNames(bundle, "main"));
    expect(skillNames(bundle, "workspace")).toEqual(skillNames(bundle, "workspace"));
    expect(skillNames(bundle, "delegated")).toEqual(skillNames(bundle, "delegated"));
    const mainPlan = planAgentSkills(bundle, "main");
    const catalog = await renderHarnessSkillCatalog({ skills: mainPlan });
    for (const skill of mainPlan) {
      expect(catalog).toContain(`- ${skill.name}:`);
      expect(catalog).toContain(`SKILL.md: ${join(skill.path, "SKILL.md")}`);
    }
    expect(catalog).not.toContain("Metadata unavailable");
  });

  it("delivers the Trigger contract skill in every trigger-capable Run plan", async () => {
    const bundle = await loadAgentSkillBundle(bundleDirectory);
    for (const { id } of agentCapabilityProfiles) {
      if (!toolsForCapabilityProfile(id).some(({ name }) => name === "trigger_write")) continue;
      const plan = resolveSkillPlan({
        bundled: planAgentSkills(bundle, id),
        integration: [],
        workspace: [],
      });
      const skill = plan?.skills.find(({ name }) => name === "opensteer-triggers");
      expect(skill, id).toEqual({
        name: "opensteer-triggers",
        path: bundle.paths["opensteer-triggers"],
      });
      const catalog = await renderHarnessSkillCatalog(plan!);
      expect(catalog).toContain(`SKILL.md: ${join(skill!.path, "SKILL.md")}`);
      expect(await readFile(join(skill!.path, "SKILL.md"), "utf8")).toContain(
        "Trigger programs execute as Node.js ESM modules",
      );
    }
  });

  it("ships browser guidance and callable recovery tools together for every browsing role", async () => {
    const bundle = await loadAgentSkillBundle(bundleDirectory);
    const recoveryTools = ["browser_session_open"];
    for (const profileId of ["main", "workspace", "delegated"] as const) {
      const selected = planAgentSkills(bundle, profileId);
      expect(selected.some(({ name }) => name === "opensteer-browser")).toBe(true);
      expect(toolsForCapabilityProfile(profileId).map(({ name }) => name)).toEqual(
        expect.arrayContaining(recoveryTools),
      );
    }
    expect(skillsForCapabilityProfile("trigger").map(({ name }) => name)).not.toContain(
      "opensteer-browser",
    );
    expect(toolsForCapabilityProfile("trigger").map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(recoveryTools),
    );

    // Check the skill's tool links against the actual catalog, not its prose.
    const skill = await readFile(join(bundle.paths["opensteer-browser"], "SKILL.md"), "utf8");
    const toolNames = new Set(agentToolDefinitions.map(({ name }) => name as string));
    const references = [...skill.matchAll(/`((?:browser|request)_[a-z_]+)`/gu)].map(
      (match) => match[1],
    );
    expect(references).toEqual(
      expect.arrayContaining([
        ...recoveryTools,
        "browser_session_list",
        "browser_profile_list",
        "browser_profile_create",
        "browser_access_request",
        "browser_tab_read",
        "request_list",
        "request_withdraw",
      ]),
    );
    for (const name of references) expect(toolNames.has(name!)).toBe(true);
  });

  it("routes app UI work to the computer tool in the skill catalog and bodies", async () => {
    const bundle = await loadAgentSkillBundle(bundleDirectory);
    const read = (name: OpensteerAgentSkillName) =>
      readFile(join(bundle.paths[name], "SKILL.md"), "utf8");
    const computers = await read("opensteer-computers");
    const computerUse = await read("opensteer-computer-use");
    const integrations = await read("opensteer-integrations");
    const computerMetadata = parseHarnessSkillMetadata(computers, "opensteer-computers");
    const computerUseMetadata = parseHarnessSkillMetadata(computerUse, "opensteer-computer-use");
    const integrationMetadata = parseHarnessSkillMetadata(integrations, "opensteer-integrations");
    expect(computerMetadata.description).toContain(
      "files, commands, repositories or ports, use SSH",
    );
    expect(computerMetadata.description).toContain(
      "To see or operate apps on a person's Mac, use the computer tool (opensteer-computer-use).",
    );
    expect(computerUseMetadata.description).toMatch(
      /^See and operate apps on a person's Mac, or a whole Android phone dedicated to agents, by writing JavaScript in the `computer` tool\./u,
    );
    for (const metadata of [computerMetadata, computerUseMetadata, integrationMetadata]) {
      expect(Array.from(metadata.description).length).toBeLessThanOrEqual(1_024);
    }
    const catalog = await renderHarnessSkillCatalog({ skills: planAgentSkills(bundle, "main") });
    for (const metadata of [computerMetadata, computerUseMetadata, integrationMetadata]) {
      expect(catalog).toContain(metadata.description);
    }
    expect(computers).toContain(
      "Use this skill for another computer's files and shell; to see or operate apps on a person's Mac, use the computer tool (opensteer-computer-use).",
    );
    expect(computerUse).toContain(
      "never read an app's private data files or use AppleScript, `screencapture`, SSH or synthetic\nevents for that purpose.",
    );
    expect(integrations).toContain("never with `integration_call`.");
  });

  it("teaches that a reply, never a report, is what reaches the person", async () => {
    const bundle = await loadAgentSkillBundle(bundleDirectory);
    const threads = await readFile(join(bundle.paths["opensteer-threads"], "SKILL.md"), "utf8");
    const triggers = await readFile(join(bundle.paths["opensteer-triggers"], "SKILL.md"), "utf8");

    expect(threads).toContain("A report never alerts the person");
    expect(threads).not.toMatch(/publish an\s+update there/u);
    expect(triggers).toContain("## Reminders and updates for the person");
    // The reminder recipe wakes Chat's agent, whose reply is the notification.
    expect(triggers).toMatch(
      /opensteer\.callTool\("thread_message", \{\s+delivery: "queue",\s+message: `Reminder: /u,
    );
    expect(triggers).toContain('threadId: "home"');
    expect(triggers).toContain("toolContractVersion: 3");
  });

  it("ships the machine access refusal sentences verbatim", async () => {
    const skill = await readFile(
      join(bundleDirectory, "skills", "opensteer-computers", "SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("Opensteer does not provide interactive terminals; run a command.");
    expect(skill).toContain("example-mac does not allow commands from other computers.");
    expect(skill).toContain("example-mac does not allow port forwarding from other computers.");
    expect(skill).toContain(
      "Not shared. example-mac shares: /Users/person/Pictures (read-only), /Users/person/Projects (read-write).",
    );
    expect(skill).toContain("Not shared. example-mac shares no folders.");
    expect(skill).toContain("Shared folder /Users/person/Pictures is read-only.");
    expect(skill).toContain(
      "Only shared folders can be changed. example-mac shares: /Users/person/Pictures (read-only), /Users/person/Projects (read-write).",
    );
    expect(skill).toContain("SFTP ~user paths are not supported.");
    expect(skill).toContain("Commands longer than 4096 bytes are refused.");
    expect(skill).toContain("`rsync` and `git` do not, because both run a command on the far side");
    // The helper substitutes the machine's display name as the Deployment
    // knows it, not the alias the caller typed, and the list is not the whole
    // set of sentences the helper can emit.
    expect(skill).toContain(
      "`example-mac` is the computer's name as shown in Opensteer, which is not always the alias you typed",
    );
    expect(skill).toContain("the common refusals are:");
    expect(skill).not.toContain("and the only ones");
    expect(skill).not.toContain("is the alias you used");
  });

  it("claims no more of machine access than it can keep", async () => {
    const skill = await readFile(
      join(bundleDirectory, "skills", "opensteer-computers", "SKILL.md"),
      "utf8",
    );

    // R5: a process that leaves its tracked group is outside the guarantee, so
    // the skill must not promise that everything it started is terminated, and
    // must not name `setsid` among the things that cannot keep work alive —
    // starting a new process group is precisely how work escapes.
    expect(skill).toContain(
      "Processes that escape their tracked process group — `setsid` and anything else that starts a new one — are outside the termination guarantee",
    );
    expect(skill).toContain("`nohup` and a trailing `&` do not keep work alive.");
    expect(skill).not.toContain("`setsid`, and a trailing `&` do not keep work alive");
    expect(skill).not.toContain("they are terminated with everything else");
    // R9: idle is measured on the session, in either direction, and a silent
    // long command ends at that timeout while still running.
    expect(skill).toContain(
      "Activity is bytes in either direction, a channel opening, or a request on the session — not output alone.",
    );
    expect(skill).toContain(
      "A session with no activity at all for 30 minutes is terminated mid-run, taking a silent command with it.",
    );
    expect(skill).not.toContain("Output is what counts");
    // The verified sandbox matrix, in the two places it is a person's business.
    expect(skill).toContain(
      "On Linux cloud Runners, this Run's sandbox may connect to any local Unix socket while machine access is set up.",
    );
    expect(skill).toContain(
      "On Codex, machine access is only set up in Full access mode, on every kind of Runner.",
    );
    expect(skill).toContain("When the note lists no computers, it says why in one sentence.");
    expect(skill).not.toContain("Codex may offer to escalate");
    // scp -O runs a remote command, so it is bounded by commands, not shares.
    expect(skill).toContain("`scp -O` is the exception");
    expect(skill).toContain("`~user` paths are refused");
  });

  it("rejects malformed metadata in the trusted bundled skills", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-agent-skills-test-"));
    temporaryDirectories.push(directory);
    await cp(bundleDirectory, directory, { recursive: true });
    await writeFile(
      join(directory, "skills", "opensteer-browser", "SKILL.md"),
      "---\nname: opensteer-browser\ndescription: [\n---\nBody\n",
    );

    await expect(loadAgentSkillBundle(directory)).rejects.toThrow(
      "Agent Skill opensteer-browser has invalid metadata",
    );
  });
});

function skillNames(...input: Parameters<typeof planAgentSkills>): readonly string[] | undefined {
  return planAgentSkills(...input).map(({ name }) => name);
}
