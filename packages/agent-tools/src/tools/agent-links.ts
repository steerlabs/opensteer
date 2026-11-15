import { z } from "zod";

export const AgentLinkSchema = z.string().min(1).max(2048);
