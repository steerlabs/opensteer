#!/usr/bin/env node

import { runLocalViewService } from "./serve.js";

runLocalViewService().catch((error) => {
  const payload =
    error instanceof Error
      ? {
          error: {
            name: error.name,
            message: error.message,
          },
        }
      : {
          error: {
            name: "Error",
            message: String(error),
          },
        };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
