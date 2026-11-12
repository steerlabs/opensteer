import { sql, type RawBuilder } from "kysely";

/** A published report is visible before consumption; waiting work is not. */
export function publishedMessagePredicate(inputAlias: string): RawBuilder<boolean> {
  const field = (name: string) => sql.ref(`${inputAlias}.${name}`);
  return sql<boolean>`(${field("messageId")} is null
    or ${field("state")} = 'delivered'
    or (${field("policy")} = 'report' and ${field("state")} <> 'cancelled'))`;
}
