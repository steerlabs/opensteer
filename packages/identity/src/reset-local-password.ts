#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { createDatabase } from "@opensteer/database";
import { issueLocalAdministratorPasswordRecovery } from "./operator-password-reset.js";

interface Arguments {
  readonly email?: string | undefined;
  readonly urlFile?: string | undefined;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const environment = await localEnvironment();
  const connectionString =
    process.env.OPENSTEER_DATABASE_URL?.trim() ||
    requiredEnvironment(environment, "OPENSTEER_DATABASE_URL");
  const publicOrigin = new URL(
    process.env.OPENSTEER_CANONICAL_ORIGIN?.trim() ||
      requiredEnvironment(environment, "OPENSTEER_CANONICAL_ORIGIN"),
  );
  const database = createDatabase({
    applicationName: "opensteer-local-password-recovery",
    connectionString,
    maxConnections: 1,
  });
  try {
    const recovery = await issueLocalAdministratorPasswordRecovery(database, {
      ...(arguments_.email ? { email: arguments_.email } : {}),
      publicOrigin,
    });
    const url = recovery.url.toString();
    if (arguments_.urlFile) {
      await writeFile(arguments_.urlFile, `${url}\n`, { encoding: "utf8", mode: 0o600 });
      stdout.write(
        `Password recovery link for ${recovery.email} was written to ${arguments_.urlFile}.\n`,
      );
    } else {
      stdout.write(
        `Open this one-use password recovery link before ${recovery.expiresAt.toISOString()}:\n${url}\n`,
      );
    }
  } finally {
    await database.destroy();
  }
}

function parseArguments(values: readonly string[]): Arguments {
  const options = values.filter((value) => value !== "--");
  let email: string | undefined;
  let urlFile: string | undefined;
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!value) throw usageError();
    if (name === "--email" && !email) email = value;
    else if (name === "--url-file" && !urlFile) urlFile = resolve(value);
    else throw usageError();
  }
  return { ...(email ? { email } : {}), ...(urlFile ? { urlFile } : {}) };
}

function usageError(): Error {
  return new Error(
    "Usage: pnpm reset:local-password [--email administrator@example.com] [--url-file path]",
  );
}

async function localEnvironment(): Promise<ReadonlyMap<string, string>> {
  const repositoryEnvironmentPath = resolve(import.meta.dirname, "../../..", ".env");
  const contents = await readFile(repositoryEnvironmentPath, "utf8");
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const raw = match[2]!.trim();
    values.set(match[1]!, raw.match(/^(['"])(.*)\1$/u)?.[2] ?? raw);
  }
  return values;
}

function requiredEnvironment(environment: ReadonlyMap<string, string>, name: string): string {
  const value = environment.get(name)?.trim();
  if (!value) throw new Error(`${name} is not set and is absent from .env.`);
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Password recovery failed: ${message}\n`);
  process.exitCode = 1;
});
