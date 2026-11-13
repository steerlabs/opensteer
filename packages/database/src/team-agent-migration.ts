import { MessageContentSchema, TeamSourceSchema } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { z } from "zod";

const legacyMessages = z.array(
  z.object({
    id: z.string(),
    channelId: z.string(),
    bodyMarkdown: z.string(),
  }),
);

export async function migrateTeamAgents(database: Kysely<unknown>): Promise<void> {
  await sql`
    update thread_inputs i set reply_target = jsonb_build_object(
      'kind','team','teamId',i.team_source->>'teamId','channelId',i.team_source->>'channelId',
      'threadRootId',i.team_source->>'threadRootId','requestId',i.team_request_id)
    where i.team_request_id is not null and i.team_source->>'teamId' is not null
      and i.team_source->>'channelId' is not null and i.team_source->>'threadRootId' is not null;
    update thread_inputs i set reply_target = jsonb_build_object(
      'kind','team','teamId',p.team_deployment_id,'channelId',p.source->>'channelId',
      'threadRootId',p.source->>'threadRootId','requestId',p.request_id),team_source=coalesce(i.team_source,p.source)
    from personal_team_requests p where p.local_input_id=i.message_id and p.local_task_id=i.thread_id
      and i.reply_target is null and p.source->>'channelId' is not null and p.source->>'threadRootId' is not null;
    update thread_inputs i set reply_target = jsonb_build_object(
      'kind','team','teamId',i.team_source->>'teamId','channelId',i.team_source->>'channelId',
      'threadRootId',i.team_source->>'threadRootId','requestId',r.team_request_id)
    from runs r where r.seed_input_id=i.message_id and r.thread_id=i.thread_id
      and r.team_request_id is not null and i.reply_target is null
      and i.team_source->>'teamId' is not null and i.team_source->>'channelId' is not null
      and i.team_source->>'threadRootId' is not null;
    update runs r set reply_target=i.reply_target from thread_inputs i
      where r.seed_input_id=i.message_id and r.thread_id=i.thread_id and i.reply_target->>'kind'='team';
    alter table runs drop column team_request_id;
    create unique index runs_team_reply_target on runs(thread_id,(reply_target->>'teamId'),(reply_target->>'requestId'))
      where reply_target->>'kind'='team';
    alter table personal_team_requests
      add column answer_message_id text references messages(id),
      add column answer_payload jsonb,
      add column client_message_id text,
      add column delivery_via text check (delivery_via in ('final','tool')),
      add column blocked_reason text;
    update personal_team_requests set delivery_via=case when explicit_reply then 'tool' else 'final' end,
      blocked_reason=case when publication_state='blocked' then 'Publication was blocked before delivery tracking was available.' end;
    create table team_agent_recipients (
      user_id text not null references team_members(user_id),
      channel_id text not null,
      root_id bigint not null,
      enabled boolean not null,
      updated_at timestamptz not null default now(),
      primary key(user_id,channel_id,root_id),
      foreign key(channel_id,root_id) references team_messages(channel_id,id)
    );
    alter table team_messages drop constraint team_messages_check1;
    alter table team_messages add constraint team_messages_agent_author check (author_kind='agent' or agent_request_id is null);
    alter table team_messages add column agent_link_id text references team_links(id),
      add column personal_deployment_id text, add column caller_run_id text, add column operation_id text;
    alter table team_blobs add column agent_link_id text references team_links(id),
      add column personal_deployment_id text, add column caller_run_id text, add column operation_id text;
    alter table team_audit add column caller_run_id text, add column operation_id text;
  `.execute(database);

  const inputs = await sql<{
    id: string;
    content: unknown;
    source: unknown;
    triggerId: string | null;
  }>`
    select m.id,m.content,coalesce(i.team_source,p.source) as source,coalesce(p.trigger_message_id::text,i.team_source->>'messageId') as trigger_id
    from messages m join thread_inputs i on i.message_id=m.id
    left join personal_team_requests p on p.local_input_id=i.message_id and p.local_task_id=i.thread_id
    where i.reply_target->>'kind'='team'
  `.execute(database);
  for (const input of inputs.rows) {
    const parsed = MessageContentSchema.safeParse(input.content);
    if (!parsed.success) continue;
    const content = parsed.data;
    const first = content[0];
    const hydrated = first?.type === "text" && first.text.startsWith("Team source and audience: ");
    const placeholder =
      content.length === 1 &&
      first?.type === "text" &&
      first.text ===
        "Read this team request's current thread and channel instructions, then answer the ask.";
    if (!hydrated && !placeholder) continue;
    let trigger: string | undefined;
    if (hydrated) {
      try {
        const source = TeamSourceSchema.parse(
          JSON.parse(first.text.slice("Team source and audience: ".length)),
        );
        const saved = TeamSourceSchema.parse(input.source);
        if (
          source.teamId === saved.teamId &&
          source.channelId === saved.channelId &&
          source.threadRootId === saved.threadRootId
        ) {
          for (const part of content.slice(1)) {
            if (part.type !== "text") continue;
            const messages = legacyMessages.safeParse(JSON.parse(part.text));
            if (messages.success)
              trigger = messages.data.find(
                (message) =>
                  message.id === input.triggerId && message.channelId === source.channelId,
              )?.bodyMarkdown;
            if (trigger !== undefined) break;
          }
        }
      } catch {
        /* Unrecognized legacy envelopes cannot recover the original ask. */
      }
    }
    const repaired = [
      {
        type: "text",
        text:
          trigger ??
          "[Team request: the original trigger text is unavailable. Read the source message with team_read.]",
      },
      ...content.filter((part) => part.type !== "text"),
    ];
    await sql`update messages set content=${JSON.stringify(repaired)}::jsonb where id=${input.id}`.execute(
      database,
    );
  }
  await sql`
    update deployment_events e set data=jsonb_set(e.data,'{message,content}',m.content)
      from messages m where e.type in ('message.created','message.placed') and e.data->'message'->>'id'=m.id
        and e.data->'message'->'content' is distinct from m.content;
    update deployment_events e set data=jsonb_set(jsonb_set(e.data,'{input,replyTarget}',i.reply_target),'{input,teamSource}',coalesce(i.team_source,'null'::jsonb))
      from thread_inputs i where e.type in ('message.created','thread-input.updated')
        and e.data->'input'->>'messageId'=i.message_id and i.reply_target->>'kind'='team'
        and (e.data->'input'->'replyTarget' is distinct from i.reply_target or e.data->'input'->'teamSource' is distinct from i.team_source);
  `.execute(database);
}
