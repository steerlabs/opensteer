import { afterEach, describe, expect, it, vi } from "vitest";
import { knowledgeExecutorClientConfig } from "./knowledge-executor.js";

const credentials = { role: "opensteer_knowledge_executor_1", password: "secret" };

function startup(hostConnectionString: string) {
  const { Client, ...config } = knowledgeExecutorClientConfig(hostConnectionString, credentials);
  const client = new Client(config) as unknown as {
    host: string;
    port: number;
    database: string;
    ssl: unknown;
    getStartupConf(): Record<string, string>;
  };
  return {
    address: { host: client.host, port: client.port, database: client.database, ssl: client.ssl },
    startup: client.getStartupConf(),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the knowledge pool's connection", () => {
  it.each([
    [
      "postgresql:///app?host=%2Ftmp%2Fsocket&port=6543",
      { host: "/tmp/socket", port: 6543, database: "app" },
    ],
    ["socket:/tmp/socket?db=app", { host: "/tmp/socket", port: 5432, database: "app" }],
    [
      "postgres://opensteer:pw@db.internal:6000/kb?sslmode=disable",
      { host: "db.internal", port: 6000, database: "kb" },
    ],
    [
      "postgresql://opensteer:pw@127.0.0.1:5433/postgres?sslmode=disable",
      { host: "127.0.0.1", port: 5433, database: "postgres" },
    ],
  ])("reaches the server and database the Host reaches from %s", (url, address) => {
    expect(startup(url).address).toEqual({ ...address, ssl: false });
  });

  it.each([
    ["postgres://u:p@db.internal/kb?sslmode=require", {}],
    ["postgres://u:p@db.internal/kb?ssl=true", {}],
    ["postgres://u:p@db.internal/kb", { PGSSLMODE: "require" }],
  ])("refuses a Host connection that uses TLS: %s %o", (url, environment) => {
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    expect(() => knowledgeExecutorClientConfig(url, credentials)).toThrow(
      "Team knowledge does not support an encrypted database connection",
    );
  });

  it("sends only who it is and where, whatever the query string or the PG environment says", () => {
    vi.stubEnv("PGOPTIONS", "-c work_mem=1GB");
    vi.stubEnv("PGREPLICATION", "database");
    vi.stubEnv("PGAPPNAME", "someone-else");
    vi.stubEnv("PGCLIENTENCODING", "SQL_ASCII");
    vi.stubEnv("PGUSER", "postgres");
    vi.stubEnv("PGPASSWORD", "other");
    vi.stubEnv("PGDATABASE", "other");
    const { startup: sent } = startup(
      "postgres://postgres:pw@127.0.0.1:5432/app?user=postgres&password=pw&options=-c%20role%3Dpostgres&application_name=x&replication=database&sslmode=disable",
    );
    expect(sent).toEqual({
      user: credentials.role,
      database: "app",
      application_name: "opensteer-knowledge",
    });
  });
});
