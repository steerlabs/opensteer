import { z } from "zod";
import { isLoopbackHostname } from "@opensteer/core";

/** The most secrets one server may ask its computer's owner for. */
export const localMcpMaxSecrets = 16;
export const LocalMcpSecretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, "A secret's name is an environment variable name")
  .refine(
    (name) => name !== "PLUGIN_ROOT" && name !== "PLUGIN_DATA",
    "PLUGIN_ROOT and PLUGIN_DATA are set by Opensteer",
  )
  // Values are kept by name in plain objects, from the form to the launch.
  .refine(
    (name) => !Object.hasOwn(Object.prototype, name),
    "A secret can't be named like a built-in object property",
  );
/**
 * A value the owner of the computer that runs a server enters when approving
 * it, such as a device password. The server's process receives it as the
 * environment variable `name`; only the declaration is part of the launch.
 */
export const LocalMcpSecretSchema = z.strictObject({
  description: z.string().trim().min(1).max(240).optional(),
  name: LocalMcpSecretNameSchema,
  title: z.string().trim().min(1).max(80),
});
export type LocalMcpSecret = z.infer<typeof LocalMcpSecretSchema>;
export const LocalMcpSecretViewSchema = z.object(LocalMcpSecretSchema.shape);

/** Absent when it asks for none, so a launch without secrets keeps its digest. */
function localMcpSecretList<Secret extends z.ZodType<LocalMcpSecret>>(secret: Secret) {
  return z
    .array(secret)
    .min(1)
    .max(localMcpMaxSecrets)
    .refine(
      (secrets) => new Set(secrets.map(({ name }) => name)).size === secrets.length,
      "Each secret needs its own name",
    )
    .optional();
}
/** A secret as entered. The Runner expands plugin path placeholders in every environment value. */
export const LocalMcpSecretValueSchema = z
  .string()
  .min(1, "Enter a value")
  .max(4_096, "This value is too long")
  .refine((value) => !value.includes("\0"), "This value can't contain a null character")
  .refine(
    (value) => !value.includes("${PLUGIN_ROOT}") && !value.includes("${PLUGIN_DATA}"),
    "This value can't contain ${PLUGIN_ROOT} or ${PLUGIN_DATA}",
  );

/** Values entered for a server's secrets, by name. */
export const LocalMcpSecretValuesSchema = z
  .record(LocalMcpSecretNameSchema, LocalMcpSecretValueSchema)
  .refine((values) => Object.keys(values).length <= localMcpMaxSecrets, "Too many secrets");

const localMcpLaunchShapes = {
  stdio: {
    pluginId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/u)
      .optional(),
    packageDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    args: z.array(z.string().max(32_768)).max(256),
    command: z.string().min(1).max(4_096),
    cwd: z.string().min(1).max(4_096),
    env: z.record(z.string().max(256), z.string().max(32_768)),
    secrets: localMcpSecretList(LocalMcpSecretSchema),
    type: z.literal("stdio"),
  },
  http: {
    pluginId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/u)
      .optional(),
    packageDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    headers: z.record(z.string().max(256), z.string().max(8_192)),
    type: z.literal("streamable-http"),
    url: z.url().refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname)
      );
    }, "A computer's own MCP server listens on its loopback"),
  },
} as const;

/**
 * An MCP server one computer runs: a program it starts, or a server already
 * listening on its own loopback. Only that computer can reach either, so the
 * Host never does; the computer runs exactly this, as its owner approved it
 * there (`docs/computers.md`, "MCP servers on a computer").
 */
export const LocalMcpLaunchSchema = z.discriminatedUnion("type", [
  z.strictObject(localMcpLaunchShapes.stdio),
  z.strictObject(localMcpLaunchShapes.http),
]);
export type LocalMcpLaunch = z.infer<typeof LocalMcpLaunchSchema>;
export const LocalMcpLaunchViewSchema = z.discriminatedUnion("type", [
  z.object({
    ...localMcpLaunchShapes.stdio,
    secrets: localMcpSecretList(LocalMcpSecretViewSchema),
  }),
  z.object(localMcpLaunchShapes.http),
]);

/** The secrets a launch asks its computer's owner for. */
export function localMcpLaunchSecrets(launch: {
  readonly secrets?: readonly LocalMcpSecret[] | undefined;
  readonly type: LocalMcpLaunch["type"];
}): readonly LocalMcpSecret[] {
  return launch.type === "stdio" ? (launch.secrets ?? []) : [];
}

/**
 * What a computer is sent to start: the approved launch with each secret's
 * value in its environment, and without their declaration, which only the
 * Host reads. Every declared secret needs a value.
 */
export function localMcpLaunchWithSecrets(
  launch: LocalMcpLaunch,
  values: Readonly<Record<string, string>>,
): LocalMcpLaunch {
  if (launch.type !== "stdio" || launch.secrets === undefined) return launch;
  const { secrets, ...started } = launch;
  const env = { ...started.env };
  for (const { name, title } of secrets) {
    const value = values[name];
    if (value === undefined) throw new Error(`${title} isn't set.`);
    if (Object.hasOwn(env, name)) throw new Error(`${name} is already set by the plugin.`);
    env[name] = value;
  }
  return { ...started, env };
}
