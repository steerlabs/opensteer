export const PLUGIN_SCHEMA_SQL = `CREATE TABLE plugins (
 id text PRIMARY KEY, name text NOT NULL CHECK (name <> 'opensteer'),
 scope text NOT NULL CHECK (scope IN ('deployment', 'workspace')),
 workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
 source jsonb NOT NULL, installed_by text REFERENCES users(id) ON DELETE RESTRICT,
 current_version_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((scope = 'workspace') = (workspace_id IS NOT NULL))
);
CREATE TABLE plugin_versions (
 id text PRIMARY KEY, plugin_id text NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
 digest text NOT NULL, manifest jsonb NOT NULL, specialist_manifest jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(plugin_id, id)
);
ALTER TABLE plugins ADD CONSTRAINT plugins_current_version FOREIGN KEY (id, current_version_id)
 REFERENCES plugin_versions(plugin_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE plugin_activations (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 plugin_id text NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
 created_by text REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id, plugin_id)
);
ALTER TABLE integration_installations ADD COLUMN plugin_id text REFERENCES plugins(id) ON DELETE RESTRICT;
ALTER TABLE integration_installations DROP CONSTRAINT integration_installations_source_kind_check;
ALTER TABLE integration_installations ADD CONSTRAINT integration_installations_source_kind_check
 CHECK(source_kind IN ('built-in','agent-plugin','plugin','proposed','remote-mcp'));
`;
