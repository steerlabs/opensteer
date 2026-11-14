import { randomUUID } from "node:crypto";
import { createId, TeamHandleSchema, type TeamChannelId } from "@opensteer/core";
import { sql } from "kysely";
import type { createTeamFixture } from "./team-fixture.test-support.js";
import { upsertRemoteTeamPrincipal } from "./team-principals-store.js";

export async function seedRemoteTeamContent(
  fixture: Awaited<ReturnType<typeof createTeamFixture>>,
  channelId: TeamChannelId,
) {
  return fixture.database.transaction().execute(async (t) => {
    await t
      .updateTable("teamChannels")
      .set({ changeSeq: "3" })
      .where("id", "=", channelId)
      .execute();
    const remote = await upsertRemoteTeamPrincipal(t, {
      homeTeamId: createId("deployment"),
      homeUserId: createId("user"),
      displayName: "Remote Alex",
      handle: TeamHandleSchema.parse("alex"),
    });
    const insert = (author: typeof fixture.userId, root: string | null, sequence: number) =>
      sql<{ id: import("@opensteer/core").TeamMessageId; clientMessageId: string }>`
        insert into team_messages(channel_id,thread_root_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq)
        values(${channelId},${root},${author},'human',${randomUUID()},'Principal fox','Principal fox',${sequence})
        returning id,client_message_id`
        .execute(t)
        .then((result) => result.rows[0]!);
    const local = await insert(fixture.userId, null, 1);
    const root = await insert(remote.id, null, 2);
    const reply = await insert(remote.id, root.id, 3);
    const blobId = createId("teamBlob");
    await sql`insert into team_blobs(id,channel_id,uploader_user_id,uploader_kind,client_upload_id,storage_key,filename,declared_type,verified_type,size_bytes,sha256,state,received_bytes,completed_at,expires_at)
      values(${blobId},${channelId},${remote.id},'human',${randomUUID()},${blobId},'remote.txt','text/plain','text/plain',3,${"a".repeat(64)},'ready',3,now(),now()+interval '1 day')`.execute(
      t,
    );
    await sql`insert into team_message_attachments(message_id,position,blob_id,channel_id)
      values(${root.id},0,${blobId},${channelId})`.execute(t);
    await sql`insert into team_mentions(message_id,channel_id,target_user_id,target_kind)
      values(${root.id},${channelId},${fixture.userId},'person'),(${local.id},${channelId},${remote.id},'person')`.execute(
      t,
    );
    await sql`insert into team_message_pins(message_id,channel_id,pinned_by)
      values(${root.id},${channelId},${remote.id})`.execute(t);
    await t
      .updateTable("teamChannels")
      .set({ latestMessageId: reply.id })
      .where("id", "=", channelId)
      .execute();
    return { remote, local, root, reply, blobId };
  });
}
