export const standardCdpMessageMaxBytes = 8 * 1024 * 1024;
export const standardCdpBufferedMaxBytes = 2 * standardCdpMessageMaxBytes;
export const standardCdpMaxPending = 128;
/**
 * The limit for one CDP command, event or answer of an agent's script or a Run's relay (a session
 * that is not standard CDP): an agent tool payload's own ceiling
 * (agentToolPayloadMaxSerializedBytes), since what it answers becomes the agent's result. Every hop
 * after the router that answers with it carries 1 MiB or more, so the router, which fails only
 * that command, is always the one that answers.
 */
export const agentCdpMessageMaxBytes = 432 * 1_024;
