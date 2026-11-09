import { Pool } from "pg";
import type { TestProject } from "vitest/node";
import setup from "../integration-global-setup.test-support.js";

export default function setupParallelismFixture(project: TestProject) {
  return setup(project, {
    // These lifecycle fixtures own their tables; application migrations add no coverage.
    migrate: async (_authority, connectionString) => {
      const pool = new Pool({ connectionString, max: 1 });
      try {
        await pool.query("create table parallel_sentinel (label text primary key)");
      } finally {
        await pool.end();
      }
    },
  });
}
