import { createHash } from "node:crypto";
import { keysetPage } from "./keyset-page.js";
import { pluginDetailPageMax, pluginDetailPreview } from "@opensteer/protocol";
import { operations } from "./engine-protocol.js";
import type { z } from "zod";

type Detail = z.infer<typeof operations.detail.output>;
export function detailSection(
  raw: unknown,
  section: "tools" | "skills" | "versions",
  cursor?: string,
) {
  const detail = operations.detail.output
    .pick({ plugin: true, tools: true, skills: true, versions: true })
    .strip()
    .parse(JSON.parse(JSON.stringify(raw)));
  const scope = `${section}\u0000${detail.plugin.id}${section === "versions" ? "" : `\u0000${detail.plugin.activeVersion}`}`;
  if (section === "versions")
    return keysetPage(
      detail.versions.map((version) => ({
        id: version.id,
        createdAt: String(version.createdAt),
        active: version.id === detail.plugin.activeVersion,
      })),
      (version) => `${version.createdAt}\u0000${version.id}`,
      { scope, cursor, max: pluginDetailPageMax, descending: true },
    );
  const items = section === "tools" ? (detail.tools?.items ?? []) : (detail.skills?.skills ?? []);
  const page = keysetPage(
    items.map((item) => ({
      key: `${item.name.slice(0, 240)}\u0000${createHash("sha256").update(item.name).digest("hex")}`,
      name: String(item.name).slice(0, 240),
      description: String(item.description ?? "").slice(0, 2000),
      ...(section === "tools" ? { readOnly: "readOnly" in item && item.readOnly === true } : {}),
    })),
    (item) => item.key,
    { scope, cursor, max: pluginDetailPageMax },
  );
  return { ...page, items: page.items.map(({ key: _key, ...item }) => item) };
}
export function detailPreview(raw: unknown): Detail {
  const detail = operations.detail.output
    .omit({ toolCount: true, skillCount: true, versionCount: true })
    .parse(JSON.parse(JSON.stringify(raw)));
  const tools = detail.tools?.items
    .map((item) => ({
      name: item.name.slice(0, 240),
      description: String(item.description ?? "").slice(0, 2000),
      readOnly: item.readOnly === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills = detail.skills?.skills
    .map((item) => ({
      name: item.name.slice(0, 240),
      description: item.description.slice(0, 2000),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ...detail,
    toolCount: tools?.length ?? 0,
    skillCount: skills?.length ?? 0,
    versionCount: detail.versions.length,
    tools: detail.tools && {
      version: detail.tools.version,
      items: tools!.slice(0, pluginDetailPreview.tools),
    },
    skills: detail.skills && {
      ...detail.skills,
      skills: skills!.slice(0, pluginDetailPreview.skills),
    },
    versions: detail.versions
      .map((version) => ({ id: version.id, createdAt: String(version.createdAt) }))
      .sort(
        (a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id),
      )
      .slice(0, pluginDetailPreview.versions),
  };
}
