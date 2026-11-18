# Writing a plugin

Write TypeScript source in a folder inside Agent home. Start with index.ts and package.json; pin the framework exactly:

```json
{ "name": "my-plugin", "type": "module", "dependencies": { "apps": "0.0.1-beta.138" } }
```

```ts
import { defineApp, object, string, query, mutation, router } from "apps";
import { always } from "apps/operations/approval";

export default defineApp(
  {},
  {
    tools: router({
      greet: query({ input: object({ name: string() }) }, async (_ctx, { name }) => ({
        message: `Hello, ${name}!`,
      })),
      change: mutation(
        { input: object({ name: string() }), approval: always() },
        async (_ctx, { name }) => ({ changed: name }),
      ),
    }),
  },
);
```

Replace the sample change handler with the requested operation. Mark reads as query and writes as mutation. Give writes `approval: always()` so ask-mode Runs ask the person. The access mode alone does not impose a read ceiling or make an unruled write ask. Return JSON-compatible values; not Date, Response, streams, undefined or BigInt. Use input/output schemas and descriptions that say what changes. Nested routers form tool paths. Never embed credentials in source or browser code.

Declare credential destinations with each provider's hosts. This is the consent the person reviews:

```ts
import { defineProvider, secrets, object, string } from "apps";
const service = defineProvider({
  name: "Example service",
  hosts: ["api.example.com"],
  auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) },
});
```

Put service under `user: {accounts: {service}}` or `app: {accounts: {service}}` in defineApp's requirements. Use the linked account from ctx.user.accounts.service or ctx.app.accounts.service and ctx.fetch. With supported protocols and hosts, fields are sealed handles used only at those destinations. Without hosts, plugin code receives the real value. Widening hosts requires the person to review the link again. Linking trusts the code, whose setup can run with the account before any tool approval.

Use async framework APIs for storage, workflows, schedules and webhook definitions; consult the pinned apps package's framework-reference.json for exact contracts and examples. Packaged skills live under skills/<name>/SKILL.md with frontmatter; reference files sit beside them. Keep source files only in the installation folder, without node_modules, caches or build output. Binary page assets belong under ui/public/; code and skill files must be UTF-8 text.

Deploy with `opensteer_plugin_install({source:"folder",directory:"my-plugin"})`. Build errors are data: fix the indicated source, then install again. To update, include pluginId; this creates a new deployed version. Installation links no accounts. Test the deployed behavior through plugin_search and a safe read before claiming success.

For an existing plugin, opensteer_plugin_export writes a version into a new Agent home folder. Preserve unrelated files, edit the draft, and reinstall with pluginId. opensteer_plugin_activate selects an earlier version; it rolls back code, not plugin data. Do not use the old plugin.json/mcp.json Agent Plugins format for sandboxed service plugins.
