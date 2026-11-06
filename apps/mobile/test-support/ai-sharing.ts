import { AiSharing, genericAiCompany } from "@opensteer/client/ai-sharing";

const sharing = new AiSharing({
  records: [],
  save: () => {},
  confirm: async () => true,
  now: () => "2026-11-06T12:00:00.000Z",
});
export const aiSharingTestPermission = { allowed: true };
export const useAiSharing = () => sharing;
export const authorizeAiSharing = () =>
  !aiSharingTestPermission.allowed
    ? Promise.resolve(false)
    : sharing.ensure("content", () => [genericAiCompany]);
