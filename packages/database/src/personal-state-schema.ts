import type {
  AppId,
  AssignmentSummary,
  DelegationId,
  DeploymentId,
  ExecutionNodeId,
  IntegrationCallSubject,
  MessageId,
  MessageAuthor,
  MessageEdit,
  MessageKind,
  Request,
  RequestId,
  RunAttemptId,
  RunId,
  RunFailure,
  RunnerId,
  TabId,
  TeamSource,
  TeamRunDelivery,
  RunUsage,
  TeamAgentRequestId,
  ThreadId,
  ToolIdentity,
  ToolOutput,
  ToolOutputImageMediaType,
} from "@opensteer/core";
import {
  personalResourceKinds,
  type PersonalResourceRevisions,
} from "@opensteer/protocol/resources";
export type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { sql, type Generated, type Kysely } from "kysely";
import type { DatabaseSchema, Timestamp } from "./schema.js";

export type PersonalScopeKey = "shell" | `thread:${string}` | `node:${string}`;
export type ClientChangeOperation = "upsert" | "remove" | "invalidate";
export type ClientEntityKind =
  "task" | "visit" | "attention" | "collection" | "thread" | "run-queue" | "request" | "item";

export const emptyPersonalResourceRevisions = Object.fromEntries(
  personalResourceKinds.map((kind) => [kind, "0"]),
) as PersonalResourceRevisions;

export interface PlaceView {
  readonly tabId: TabId;
  readonly title: string;
  readonly site: string | null;
}

export interface FinishIntent {
  readonly attemptId: RunAttemptId | null;
  readonly mode?: "host" | "runner" | "recovery" | "steer";
  readonly bindingGeneration: number | null;
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly completedAt: string;
  readonly replyMessageId: MessageId | null;
  readonly requestCancellationReason?: import("@opensteer/core").RequestCancellationReason;
  readonly queuedInputCancellation?: "activation-input" | "authority-cohort" | "seed-input";
  readonly failure?: RunFailure;
  readonly statement?: {
    readonly ordinal: number;
    readonly runnerId: RunnerId;
    readonly runnerBootId: string;
    readonly digest: string;
  };
}

export interface ClientSyncStateTable {
  deploymentId: DeploymentId;
  sequence: Generated<string>;
  epoch: Generated<string>;
  ready: Generated<boolean>;
  prunedThroughSequence: Generated<string>;
  retainedChangeCount: Generated<number>;
  lastCommitAt: Timestamp;
  resourceRevisions: Generated<PersonalResourceRevisions>;
  pendingRequestCount: Generated<number>;
  pendingDeviceAccessRequestCount: Generated<number>;
  needsYouCount: Generated<number>;
  unreadTaskCount: Generated<number>;
}

export interface ClientChangesTable {
  deploymentId: DeploymentId;
  sequence: string;
  scopeKey: PersonalScopeKey;
  ordinal: number;
  entityKind: ClientEntityKind;
  entityId: string;
  operation: ClientChangeOperation;
  payload: Record<string, unknown>;
  createdAt: Timestamp;
  byteCount: Generated<number>;
}

export interface ToolCallTable {
  id: string;
  threadId: ThreadId;
  runId: RunId;
  attemptId: RunAttemptId | null;
  bindingGeneration: number | null;
  nodeId: ExecutionNodeId | null;
  callId: string;
  origin: "runner" | "host-harness" | "host-computer";
  tool: ToolIdentity | null;
  integration: IntegrationCallSubject | null;
  arguments: unknown;
  argumentDigest: Buffer | null;
  provisional: Generated<boolean>;
  status: "open" | "completed" | "interrupted";
  output: ToolOutput | null;
  isError: boolean | null;
  startedAt: Date | null;
  completedAt: Date | null;
  completionOrder: string | null;
}

export interface TranscriptPreview {
  readonly title?: string | undefined;
  readonly preview?: string | undefined;
  readonly status?: string;
  readonly author?: string;
  readonly edited?: boolean;
  readonly published?: boolean;
  readonly truncated?: boolean;
  readonly version?: number;
  readonly assignment?: AssignmentSummary;
  readonly teamSource?: TeamSource;
  readonly completedAt?: string;
  readonly tool?: ToolIdentity | null;
  readonly requestKind?: Request["kind"];
  readonly waitedSince?: string;
  readonly endedAt?: string;
  readonly replyMessageId?: MessageId;
  readonly failure?: RunFailure;
  readonly usage?: RunUsage;
  readonly runDelivery?: TeamRunDelivery;
  readonly messageKind?: Extract<MessageKind, "input" | "assistant" | "continuation">;
  readonly messageAuthor?: MessageAuthor;
  readonly edit?: MessageEdit;
  readonly delivery?: { readonly status: "failed" | "unconfirmed"; readonly reason: string };
}

export type TranscriptItemKind =
  | "message"
  | "tool"
  | "run"
  | "request"
  | "node"
  | "assignment"
  | "delegation"
  | "app"
  | "reasoning"
  | "node-message"
  | "place";

export interface TranscriptItemTable {
  id: string;
  threadId: ThreadId;
  runId: RunId | null;
  attemptId: RunAttemptId | null;
  nodeId: ExecutionNodeId | null;
  kind: TranscriptItemKind;
  position: string | null;
  revision: Generated<string>;
  visible: boolean;
  isTurnStart: boolean;
  createdAt: Timestamp;
  messageId: Generated<MessageId | null>;
  toolCallId: Generated<string | null>;
  requestId: Generated<RequestId | null>;
  executionNodeId: Generated<ExecutionNodeId | null>;
  delegationId: Generated<DelegationId | null>;
  appId: Generated<AppId | null>;
  bindingGeneration: Generated<number | null>;
  blockId: Generated<string | null>;
  body: Generated<string | PlaceView | null>;
  view: TranscriptPreview;
}

export interface ToolOutputImageTable {
  id: string;
  toolCallId: string;
  imageIndex: number;
  threadId: ThreadId;
  nodeId: ExecutionNodeId | null;
  path: string;
  pathHash: Buffer;
  mediaType: ToolOutputImageMediaType;
  generated: boolean;
  completionOrder: string;
}

export interface RunnerEventReceiptTable {
  runId: RunId;
  ordinal: number;
  runnerId: RunnerId;
  runnerBootId: string;
  bindingGeneration: number;
  reportedDigest: Buffer;
  disposition: "applied" | "absorbed" | "terminal-noop";
  committedHead: string;
}

export interface PersonalAttentionTable {
  id: string;
  kind: "request" | "team-ask" | "failed-ask";
  requestId: RequestId | null;
  teamDeploymentId: DeploymentId | null;
  teamRequestId: TeamAgentRequestId | null;
  threadId: ThreadId | null;
  sortAt: Timestamp;
  expiresAt: Date | null;
  revision: Generated<string>;
}

export const uncertainEarlierRun =
  "started_at is null and binding_generation is not null and not runner_safety_terminal and execute_claim_state <> 'unclaimed'";

const revisionKeys = `array[${personalResourceKinds.map((kind) => `'${kind}'`).join(",")}]`;
const resourceRevisionCheck = personalResourceKinds
  .map(
    (kind) => `jsonb_typeof(resource_revisions->'${kind}') = 'string' and
    (resource_revisions->>'${kind}') ~ '^(0|[1-9][0-9]{0,18})$' and
    (resource_revisions->>'${kind}')::numeric <= sequence`,
  )
  .join(" and ");

const retainedStateDdl = `
  alter table deployment_event_state rename to client_sync_state;
  alter table client_sync_state
    add foreign key (deployment_id) references deployments(id) on delete cascade,
    add column epoch uuid not null default gen_random_uuid(),
    add column ready boolean not null default false,
    add column pruned_through_sequence bigint not null default 0
      check (pruned_through_sequence between 0 and sequence),
    add column retained_change_count integer not null default 0 check (retained_change_count between 0 and 4096),
    add column last_commit_at timestamptz not null default clock_timestamp(),
    add column resource_revisions jsonb not null default '${JSON.stringify(emptyPersonalResourceRevisions)}',
    add column pending_request_count integer not null default 0 check (pending_request_count >= 0),
    add column pending_device_access_request_count integer not null default 0
      check (pending_device_access_request_count between 0 and pending_request_count),
    add column needs_you_count integer not null default 0 check (needs_you_count >= pending_request_count),
    add column unread_task_count integer not null default 0 check (unread_task_count >= 0),
    add column upgrade_cursor jsonb,
    add check (jsonb_typeof(resource_revisions) = 'object'
      and resource_revisions ?& ${revisionKeys}
      and resource_revisions - ${revisionKeys} = '{}'::jsonb and ${resourceRevisionCheck});

  create table client_changes (
    deployment_id text not null references client_sync_state(deployment_id) on delete cascade,
    sequence bigint not null check (sequence > 0),
    scope_key text not null check (scope_key = 'shell' or scope_key ~ '^(thread|node):.+$'),
    ordinal smallint not null check (ordinal between 0 and 127),
    entity_kind text not null,
    entity_id text not null,
    operation text not null check (operation in ('upsert','remove','invalidate')),
    payload jsonb not null check (jsonb_typeof(payload) = 'object'),
    created_at timestamptz not null,
    byte_count integer generated always as (octet_length(payload::text)) stored check (byte_count <= 8192),
    primary key (deployment_id, sequence, ordinal),
    check (
      (scope_key = 'shell' and entity_kind in ('task','visit','attention','collection'))
      or (scope_key <> 'shell' and entity_kind in ('thread','run-queue','request','item','collection'))
    )
  );
  create index client_changes_scope on client_changes(deployment_id,scope_key,sequence,ordinal);

  create function opensteer_valid_place(value jsonb) returns boolean
  language sql immutable strict parallel safe return
    jsonb_typeof(value) = 'object' and value ?& array['tabId','title','site']
    and value - array['tabId','title','site'] = '{}'::jsonb
    and jsonb_typeof(value->'tabId') = 'string' and length(value->>'tabId') between 1 and 255
    and jsonb_typeof(value->'title') = 'string' and octet_length(value->>'title') <= 1024
    and (value->'site' = 'null'::jsonb or (jsonb_typeof(value->'site') = 'string'
      and octet_length(value->>'site') <= 2048));

  alter table threads
    add column revision bigint not null default 0 check (revision >= 0),
    add column next_transcript_position bigint not null default 0 check (next_transcript_position >= 0),
    add column transcript_order_revision bigint not null default 0 check (transcript_order_revision >= 0),
    add column input_queue_revision bigint not null default 0 check (input_queue_revision >= 0),
    add column last_reply_message_id text references messages(id) on delete set null,
    add column last_reply_preview text check (octet_length(last_reply_preview) <= 1120),
    add column failure_preview text check (octet_length(failure_preview) <= 1120),
    add column latest_run_completed_at timestamptz,
    add column latest_place jsonb check (opensteer_valid_place(latest_place)),
    add column removed_at timestamptz;

  -- Existing messages are usually published. The converter corrects exceptions.
  alter table messages add column published boolean not null default true,
    add unique (id,run_id,thread_id);
  alter table messages alter column published set default false;
  alter table runs
    add column revision bigint not null default 0 check (revision >= 0),
    add column latest_place jsonb check (opensteer_valid_place(latest_place)),
    add column terminal_reply_message_id text,
    add column runner_safety_terminal boolean not null default false,
    add column execute_claim_state text not null default 'not-created'
      check (execute_claim_state in ('not-created','unclaimed','claimed')),
    add column finish_intent jsonb check (jsonb_typeof(finish_intent) = 'object' and octet_length(finish_intent::text) <= 8192),
    add constraint runs_terminal_reply_fkey foreign key (terminal_reply_message_id,id,thread_id)
      references messages(id,run_id,thread_id) deferrable initially deferred,
    add check (terminal_reply_message_id is null or status = 'completed');
  alter table requests add column revision bigint not null default 0 check (revision >= 0);
  alter table run_attempts add unique (id,run_id);
  alter table execution_nodes add unique (id,run_id,attempt_id);
  alter table personal_team_links add column approval_attention_count integer not null default 0
    check (approval_attention_count >= 0);
  alter table thread_inputs add column approval_sort smallint generated always as
    (case when state = 'awaiting-approval' then 1 else 0 end) stored;

  -- Offline conversion initializes the counts before setting ready.
  create function opensteer_update_thread_request_count() returns trigger language plpgsql as $$
  declare
    task_id text;
    contribution integer;
  begin
    if TG_TABLE_NAME = 'requests' then
      task_id := coalesce(new.originating_thread_id, old.originating_thread_id);
      contribution := (case when new.status = 'pending' then 1 else 0 end)
                    - (case when old.status = 'pending' then 1 else 0 end);
    else
      task_id := coalesce(new.thread_id, old.thread_id);
      contribution := (case when new.state = 'awaiting-approval' then 1 else 0 end)
                    - (case when old.state = 'awaiting-approval' then 1 else 0 end);
    end if;
    if contribution <> 0 and exists (select 1 from client_sync_state where ready) then
      update threads set pending_request_count = pending_request_count + contribution
      where id = task_id;
    end if;
    return null;
  end;
  $$;

  create trigger thread_request_count after insert or update of status or delete on requests
    for each row execute function opensteer_update_thread_request_count();
  create trigger thread_input_approval_count after insert or update of state or delete on thread_inputs
    for each row execute function opensteer_update_thread_request_count();

  create table tool_calls (
    id text primary key,
    thread_id text not null references threads(id) on delete cascade,
    run_id text not null,
    attempt_id text,
    binding_generation integer check (binding_generation >= 0),
    node_id text,
    call_id text not null check (length(call_id) > 0),
    origin text not null check (origin in ('runner','host-harness','host-computer')),
    tool jsonb check (jsonb_typeof(tool) = 'object'),
    integration jsonb check (jsonb_typeof(integration) = 'object'),
    arguments jsonb,
    argument_digest bytea check (argument_digest is null or (octet_length(argument_digest) = 32 and origin <> 'runner')),
    provisional boolean not null default false check (not provisional or (origin = 'runner' and started_at is not null)),
    status text not null check (status in ('open','completed','interrupted')),
    output jsonb check (jsonb_typeof(output) = 'object' and octet_length(output::text) <= 360448),
    is_error boolean,
    started_at timestamptz,
    completed_at timestamptz,
    completion_order bigint check (completion_order > 0),
    unique nulls not distinct (run_id,attempt_id,binding_generation,node_id,call_id),
    foreign key (run_id,thread_id) references runs(id,thread_id) on delete cascade,
    foreign key (attempt_id,run_id) references run_attempts(id,run_id) on delete cascade,
    foreign key (node_id,run_id,attempt_id) references execution_nodes(id,run_id,attempt_id) on delete cascade,
    constraint tool_calls_node_attempt check (node_id is null or attempt_id is not null),
    constraint tool_calls_runner_binding check (origin <> 'runner' or (attempt_id is not null and binding_generation is not null)),
    constraint tool_calls_start check ((started_at is null) = (tool is null) and (started_at is null) = (arguments is null)),
    constraint tool_calls_outcome check (
      (status = 'open' and started_at is not null and num_nonnulls(output,is_error,completed_at,completion_order) = 0)
      or (status = 'completed' and num_nonnulls(output,is_error,completed_at,completion_order) = 4)
      or (status = 'interrupted' and started_at is not null and completed_at is not null
        and num_nonnulls(output,is_error,completion_order) = 0)
    )
  );
  create index tool_calls_open_origin on tool_calls(origin,run_id,id) where status = 'open';
  create index tool_calls_open_binding on tool_calls(run_id,binding_generation,id) where status = 'open';
  create index tool_calls_open_run on tool_calls(run_id,id) where status = 'open';
  create index tool_calls_open_scope on tool_calls(thread_id,node_id,id) where status = 'open';
  create index tool_calls_open on tool_calls(id) where status = 'open';
  create index tool_calls_attempt on tool_calls(attempt_id);
  create index tool_calls_node on tool_calls(node_id);
  create index tool_calls_thread on tool_calls(thread_id);

  create table transcript_items (
    id text primary key,
    thread_id text not null references threads(id) on delete cascade,
    run_id text,
    attempt_id text,
    node_id text,
    kind text not null,
    position bigint check (position > 0),
    revision bigint not null default 0 check (revision >= 0),
    visible boolean not null check (not visible or position is not null),
    is_turn_start boolean not null check (not is_turn_start or (visible and kind = 'message' and node_id is null)),
    created_at timestamptz not null,
    message_id text unique,
    tool_call_id text unique references tool_calls(id) on delete cascade,
    request_id text unique references requests(id) on delete cascade,
    execution_node_id text unique references execution_nodes(id) on delete cascade,
    delegation_id text references delegations(id) on delete cascade,
    app_id text references apps(id) on delete cascade,
    binding_generation integer check (binding_generation >= 0),
    block_id text,
    body jsonb,
    view jsonb not null check (jsonb_typeof(view) = 'object' and octet_length(view::text) <= 2048),
    foreign key (message_id,thread_id) references messages(id,thread_id) on delete cascade,
    foreign key (run_id,thread_id) references runs(id,thread_id) on delete cascade,
    foreign key (attempt_id,run_id) references run_attempts(id,run_id) on delete cascade,
    foreign key (node_id,run_id,attempt_id) references execution_nodes(id,run_id,attempt_id) on delete cascade,
    check (attempt_id is null or run_id is not null),
    check (node_id is null or attempt_id is not null),
    check ((kind = 'reasoning') = (block_id is not null)),
    check (num_nonnulls(message_id,tool_call_id,request_id,execution_node_id,delegation_id,app_id,body)
      = case when kind = 'run' then 0 else 1 end),
    check (case kind
      when 'message' then id = message_id and message_id is not null and node_id is null
      when 'tool' then id = 'tool:'||tool_call_id and tool_call_id is not null and run_id is not null
      when 'run' then id = 'run:'||run_id and run_id is not null and node_id is null
      when 'request' then id = 'request:'||request_id and request_id is not null
      when 'node' then id = 'node:'||execution_node_id and execution_node_id is not null
        and execution_node_id is distinct from node_id and attempt_id is not null
      when 'assignment' then delegation_id is not null
      when 'delegation' then delegation_id is not null
      when 'app' then app_id is not null
      when 'reasoning' then run_id is not null and body is not null
        and jsonb_typeof(body) = 'string' and octet_length(body #>> '{}') <= 491520
      when 'node-message' then node_id is not null and body is not null
        and jsonb_typeof(body) = 'string' and octet_length(body #>> '{}') <= 491520
      when 'place' then run_id is not null and body is not null and opensteer_valid_place(body)
      else false end)
  );
  create unique index transcript_run on transcript_items(run_id) where kind = 'run';
  create unique index transcript_delegation on transcript_items(thread_id,kind,delegation_id) where delegation_id is not null;
  create unique index transcript_app on transcript_items(thread_id,app_id) where app_id is not null;
  create unique index transcript_reasoning on transcript_items(run_id,attempt_id,binding_generation,node_id,block_id)
    nulls not distinct where kind = 'reasoning';
  create index transcript_thread on transcript_items(thread_id);
  create index transcript_run_sources on transcript_items(run_id);
  create index transcript_attempt on transcript_items(attempt_id);
  create index transcript_node_sources on transcript_items(node_id);
  create index transcript_app_source on transcript_items(app_id) where app_id is not null;
  create index transcript_delegation_source on transcript_items(delegation_id) where delegation_id is not null;

  create table tool_output_images (
    id text primary key,
    tool_call_id text not null references tool_calls(id) on delete cascade,
    image_index smallint not null check (image_index between 0 and 7),
    thread_id text not null references threads(id) on delete cascade,
    node_id text references execution_nodes(id) on delete cascade,
    path text not null check (length(path) between 1 and 1024),
    path_hash bytea not null check (octet_length(path_hash) = 32),
    media_type text not null check (media_type in
      ('image/png','image/jpeg','image/webp','image/gif','image/avif','image/svg+xml')),
    generated boolean not null,
    completion_order bigint not null check (completion_order > 0),
    unique (tool_call_id,image_index)
  );
  create index tool_output_images_path on tool_output_images(thread_id,path_hash,completion_order desc,image_index desc);
  create index tool_output_images_scope_path on tool_output_images(thread_id,node_id,path_hash,completion_order desc,image_index desc);
  create index tool_output_images_node on tool_output_images(node_id) where node_id is not null;

  create table runner_event_receipts (
    run_id text not null references runs(id) on delete cascade,
    ordinal bigint not null check (ordinal >= 0),
    runner_id text not null,
    runner_boot_id text not null,
    binding_generation integer not null check (binding_generation > 0),
    reported_digest bytea not null check (octet_length(reported_digest) = 32),
    disposition text not null check (disposition in ('applied','absorbed','terminal-noop')),
    committed_head bigint not null check (committed_head >= 0),
    primary key (run_id,ordinal)
  );

  create table personal_attention (
    id text primary key,
    kind text not null check (kind in ('request','team-ask','failed-ask')),
    request_id text unique references requests(id) on delete cascade,
    team_deployment_id text,
    team_request_id text,
    thread_id text references threads(id) on delete set null,
    sort_at timestamptz not null,
    expires_at timestamptz,
    revision bigint not null default 0 check (revision >= 0),
    unique (team_deployment_id,team_request_id),
    foreign key (team_deployment_id,team_request_id) references personal_team_requests(team_deployment_id,request_id)
      match full on delete cascade,
    check (case when kind = 'request' then request_id is not null and team_request_id is null
      else request_id is null and team_request_id is not null end),
    check ((kind = 'team-ask') = (expires_at is not null))
  );
  create index personal_attention_direct on personal_attention(sort_at desc,id desc) where kind in ('request','failed-ask');
  create index personal_attention_team on personal_attention(team_deployment_id,sort_at desc,id desc) where kind = 'team-ask';
  create index personal_attention_expiry on personal_attention(expires_at,id) where kind = 'team-ask';
  create index personal_attention_thread on personal_attention(thread_id) where thread_id is not null;
`;

const transcriptOrderIndexes = {
  transcript_root:
    "on transcript_items(thread_id,position desc,id desc) where visible and node_id is null",
  transcript_node:
    "on transcript_items(node_id,position desc,id desc) where visible and node_id is not null",
  transcript_run_place:
    "on transcript_items(run_id,position desc,id desc) where visible and kind = 'place'",
  transcript_root_activity: `on transcript_items(thread_id,position desc,id desc)
    where visible and node_id is null and kind in ('message','tool','place','app','request','node')`,
  transcript_node_activity: `on transcript_items(node_id,position desc,id desc)
    where visible and node_id is not null and kind in ('node-message','tool')`,
};

const transcriptOrderIndexEntries = Object.entries(transcriptOrderIndexes);

export async function createNextPersonalTranscriptOrderIndex(
  database: Kysely<DatabaseSchema>,
  previous: string,
): Promise<string | null> {
  const index = previous
    ? transcriptOrderIndexEntries.findIndex(([name]) => name === previous)
    : -1;
  if (previous && index === -1) throw new Error("Unknown transcript order index");
  const entry = transcriptOrderIndexEntries[index + 1];
  if (!entry) return null;
  const [name, definition] = entry;
  await sql`create index if not exists ${sql.id(name)} ${sql.raw(definition)}`.execute(database);
  return name;
}

const currentStateIndexes = `
  alter table delegations add column cancellation_root_id text
    check (cancellation_root_id is null or status = 'cancelled');
  create index delegations_pending_cancellation on delegations(cancellation_root_id,id)
    where cancellation_root_id is not null;
  create index delegations_open_child on delegations(parent_assignment_id,id) where status = 'open';
  create index thread_inputs_pending_assignment on thread_inputs(assignment_id,message_id) where state = 'pending';
  create index requests_pending_origin_thread on requests(originating_thread_id,id) where status = 'pending';
  create index thread_inputs_current_channel_binding on thread_inputs((authority_source->>'bindingId'),message_id)
    where state in ('pending','unknown') and authority_source->>'kind'='channel-ingress';
  create index threads_current_recent on threads(asked_at desc,id desc)
    where listed and removed_at is null and done_at is null and status <> 'archived';
  create index threads_current_active on threads(asked_at desc,id desc)
    where listed and removed_at is null and done_at is null and status in ('running','waiting');
  create index threads_current_done on threads(done_at desc,id desc)
    where listed and removed_at is null and done_at is not null and status <> 'archived';
  create index threads_removed on threads(id) where removed_at is not null;
  create index threads_last_reply_source on threads(last_reply_message_id) where last_reply_message_id is not null;
  create index messages_current_published on messages(thread_id,sequence desc) where published;
  create index runs_current_queue on runs(thread_id,run_ordinal)
    where status in ('queued','starting','running','waiting');
  create index runs_current_latest on runs(thread_id,run_ordinal desc) where maintenance is null;
  create index runs_session_started on runs(provider_session_id,run_ordinal) where started_at is not null;
  create index runs_thread_started on runs(thread_id,run_ordinal) where started_at is not null;
  create index runs_session_uncertain on runs(provider_session_id,run_ordinal) where ${uncertainEarlierRun};
  create index runs_thread_uncertain on runs(thread_id,run_ordinal) where ${uncertainEarlierRun};
  create index runs_finishing on runs(id) where finish_intent is not null;
  create index runs_terminal_reply_source on runs(terminal_reply_message_id) where terminal_reply_message_id is not null;
  create index provider_sessions_prior_reference on provider_sessions(thread_id,id) where provider_session_reference is not null;
  create index commands_execution_proof on commands(run_id,type,id) where run_id is not null;
  create index commands_unclaimed_execute on commands(run_id,id) where type = 'run.execute' and attempts = 0;
  create index commands_current_run on commands(run_id,id) where run_id is not null and status in ('pending','dispatched','unknown');
  create index commands_task_adoption on commands(thread_id,id) where type in ('thread.rename','thread.done.set','thread.archive');
  create index requests_current_run on requests(originating_run_id,id) where status = 'pending';
  create index requests_current_run_end on requests(originating_run_id,id)
    where status = 'pending' and (mode = 'live' or kind = 'integration.input');
  create index requests_current_thread on requests(originating_thread_id,id) where status = 'pending' and originating_node_id is null;
  create index requests_password_sign_in_deadline on requests((payload->>'expiresAt'),id)
    where kind='browser.password-sign-in' and status='pending';
  create index personal_team_requests_consent_deadline
    on personal_team_requests(consent_expires_at,team_deployment_id,request_id)
    where kind='ask' and terminal_state is null and local_decision is null and consent_expires_at is not null;
  create index computer_app_setup_requests_deadline on computer_app_setup_requests(expires_at,id);
  create index requests_current_node on requests(originating_node_id,id) where status = 'pending' and originating_node_id is not null;
  create index run_attempts_binding on run_attempts(run_id,binding_generation,id);
  create index run_attempts_open on run_attempts(run_id,id) where ended_at is null;
  create index run_attempts_recent_recovery on run_attempts(run_id,started_at desc) where reason = 'recovery';
  create index execution_nodes_current_run on execution_nodes(run_id,id) where status = 'running';
  create index execution_nodes_current_root on execution_nodes(run_id,id)
    where status = 'running' and parent_node_id is null;
  create index execution_nodes_current_parent on execution_nodes(parent_node_id,id) where status = 'running';
  create index grants_current_run on grants(run_id,id) where status = 'active';
  create index thread_inputs_current_steer on thread_inputs(run_id,message_id)
    where steer_command_id is not null and state = 'claimed';
  create index thread_inputs_current_queue on thread_inputs(thread_id,approval_sort,queue_rank,message_id)
    where policy = 'queue' and state in ('pending','awaiting-approval');
  create index runs_current_seed on runs(seed_input_id) where status in ('queued','starting','running','waiting');
  create index runs_seed_source on runs(seed_input_id,run_ordinal desc);
  create index runs_with_finish_intent on runs(id) where finish_intent is not null;
  create index runs_unsettled_upgrade on runs(id) where status in ('queued','starting','running','waiting');
  create index delegations_current_parent_run on delegations(parent_run_id,id)
    where status = 'open';
  create index personal_team_links_approval_buckets on personal_team_links(team_deployment_id)
    where approval_attention_count > 0 and state in ('active','unreachable','needs_update');

  create index personal_team_requests_local_task on personal_team_requests(local_task_id,request_id);
  create index personal_team_requests_local_input on personal_team_requests(local_input_id) where local_input_id is not null;
  create index personal_team_requests_local_run on personal_team_requests(run_id) where run_id is not null;
  create index commands_thread_fk on commands(thread_id);
  create index trigger_watch_activations_task on trigger_watch_activations(anchor_thread_id);
  create index triggers_creator_task on triggers(created_by_thread_id);
  create index trigger_revisions_creator_task on trigger_revisions(created_by_thread_id);
  create index channel_conversations_active_task on channel_conversations(active_thread_id);
  create index channel_ingress_events_message on channel_ingress_events(message_id);
  create index causal_chains_root_message on causal_chains(root_message_id);
  create index thread_inputs_chain on thread_inputs(causal_chain_id);
  create index runs_chain on runs(causal_chain_id);
  create index trigger_occurrences_chain on trigger_occurrences(causal_chain_id);
  create index apps_task on apps(thread_id);
  create index apps_run on apps(run_id);
`;

export async function applyPersonalStateSchema(transaction: Kysely<DatabaseSchema>) {
  await sql.raw(retainedStateDdl).execute(transaction);
  await sql.raw(currentStateIndexes).execute(transaction);
}
