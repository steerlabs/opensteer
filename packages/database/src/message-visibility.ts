import { sql, type RawBuilder } from "kysely";

/** A published report is visible before consumption; waiting work is not. */
export function publishedMessagePredicate(inputAlias: string): RawBuilder<boolean> {
  const field = (name: string) => sql.ref(`${inputAlias}.${name}`);
  return sql<boolean>`(${field("messageId")} is null
    or ${field("state")} = 'delivered'
    or (${field("policy")} = 'report' and ${field("state")} <> 'cancelled'))`;
}

/** Keep the unread lookup's clauses identical to its partial index predicate. */
export function conversationUnreadPredicate(messageAlias?: string): RawBuilder<boolean> {
  const field = (name: string) => sql.ref(messageAlias ? `${messageAlias}.${name}` : name);
  return sql<boolean>`(${field("kind")} in ('assistant', 'run-result')
    or (${field("kind")} = 'input' and ${field("author")}->>'kind' = 'human'))`;
}
