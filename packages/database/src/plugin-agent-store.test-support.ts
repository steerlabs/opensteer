import { sql, type Kysely } from "kysely";
import type { UserId } from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";

/**
 * A plugin version's author, as the engine records it when an install makes the version active,
 * for a test whose install ran before the person's settings existed or that needs an author the
 * install did not write.
 */
export async function recordPluginAuthor(
  database: Kysely<DatabaseSchema>,
  owner: UserId,
  plugin: string,
  version: string,
  author: "catalog" | "agent",
) {
  await sql`insert into plugin_agent_settings (owner_user_id, plugin_id, access, author, version_authors)
    values (${owner}, ${plugin}, 'all', ${author}, jsonb_build_object(${version}::text, ${author}::text))
    on conflict (owner_user_id, plugin_id) do update set author = excluded.author,
      version_authors = plugin_agent_settings.version_authors || excluded.version_authors`.execute(
    database,
  );
}
