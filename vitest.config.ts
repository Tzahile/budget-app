import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The production database is provided by Val Town. Repository integration
// tests replace only that boundary with SQLite in memory, while executing the
// same repository and migration code used by the HTTP entrypoint.
export default defineConfig({
  resolve: {
    alias: {
      "npm:hono@4.13.7": "hono",
      "npm:hono@4/html": "hono/html",
      "npm:hono@4/jsx": "hono/jsx",
      "https://esm.town/v/std/sqlite/main.ts": fileURLToPath(new URL("./tests/support/val-sqlite.ts", import.meta.url)),
      "https://esm.town/v/std/oauth/middleware.ts": fileURLToPath(new URL("./tests/support/oauth-middleware.ts", import.meta.url)),
      "https://esm.town/v/std/utils/index.ts": fileURLToPath(new URL("./tests/support/val-utils.ts", import.meta.url)),
    },
  },
});
