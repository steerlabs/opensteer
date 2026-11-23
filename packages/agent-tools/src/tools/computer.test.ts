import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { requestToolNames, toolsFor } from "../index.js";
import { app_access_request, computer_access_request, computer_use } from "./computer.js";

it("offers local access requests and computer_use to Runs, Trigger occurrences, and watches (T5 / Y9)", () => {
  const accessMode = "full-access";
  expect(toolsFor({ kind: "run", accessMode })).toContain(app_access_request);
  expect(toolsFor({ kind: "program", program: { kind: "trigger" }, accessMode })).toContain(
    app_access_request,
  );
  expect(toolsFor({ kind: "program", program: { kind: "watch" }, accessMode })).toContain(
    app_access_request,
  );
  expect(toolsFor({ kind: "program", program: { kind: "trigger" }, accessMode })).toContain(
    computer_use,
  );
  expect(toolsFor({ kind: "program", program: { kind: "watch" }, accessMode })).toContain(
    computer_use,
  );
  expect(toolsFor({ kind: "connection", accessMode })).not.toContain(app_access_request);
});

it("exposes computer access to Runs and automation scripts, never connections, as a durable Request (T5)", () => {
  expect(toolsFor({ kind: "run", accessMode: "full-access" })).toContain(computer_access_request);
  expect(toolsFor({ kind: "program", accessMode: "full-access" })).toContain(
    computer_access_request,
  );
  expect(toolsFor({ kind: "connection", accessMode: "full-access" })).not.toContain(
    computer_access_request,
  );
  expect(requestToolNames).toContain("computer_access_request");
  const input = {
    computerId: createId("runner"),
    access: "full_disk_access",
    reason: "Read the task's project",
  };
  expect(computer_access_request.input.parse(input)).toEqual(input);
  expect(computer_access_request.input.safeParse({ ...input, allowForTask: true }).success).toBe(
    false,
  );
});

it("keeps excluded tools out of the program tool surface while unlocking script tools (T5 / Y9)", () => {
  const names = new Set(
    toolsFor({ kind: "program", program: { kind: "trigger" }, accessMode: "full-access" }).map(
      (tool) => tool.name,
    ),
  );
  for (const unlocked of [
    "tab_list",
    "tab_open",
    "tab_close",
    "tab_organize",
    "tab_group_update",
    "app_publish",
    "app_start",
    "app_stop",
    "app_delete",
    "send_to_person",
    "ask_person",
    "computer_use",
    "browser_profile_request",
    "computer_access_request",
    "plugin_account_request",
    "app_access_request",
    "opensteer_request_answer",
    "opensteer_request_withdraw",
    "opensteer_delegation_cancel",
    "opensteer_plugin_list",
    "opensteer_plugin_install",
    "opensteer_plugin_export",
    "opensteer_plugin_activate",
    "opensteer_plugin_remove",
    "opensteer_plugin_catalog",
    "plugin_resources",
    "opensteer_plugin_resource_update",
    "local_server_add",
    "local_server_remove",
  ]) {
    expect(names, `expected ${unlocked} to be unlocked for scripts`).toContain(unlocked);
  }
  for (const excluded of [
    "opensteer_subagent_stop",
    "discover",
    "browser_use",
    "browser_connect",
    "show_to_person",
    "saved_login_request",
    "card_request",
    "chrome_cookies_request",
  ]) {
    expect(names, `expected ${excluded} to stay excluded for scripts`).not.toContain(excluded);
  }
});
