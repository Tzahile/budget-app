import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, URL } from "node:url";
import { createServer } from "vite";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const file = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const database = new DatabaseSync(":memory:");
globalThis.Deno = { env: { get: () => "" } };

const server = await createServer({
  root: fileURLToPath(new URL("./", import.meta.url)),
  configFile: false,
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^https:\/\/esm\.sh\/react@18\.2\.0(.*)$/, replacement: "react$1" },
      { find: "npm:hono@4.13.7", replacement: "hono" },
      { find: "npm:hono@4/html", replacement: "hono/html" },
      { find: "npm:hono@4/jsx", replacement: "hono/jsx" },
      { find: "https://esm.town/v/std/sqlite/main.ts", replacement: file("tests/support/val-sqlite.ts") },
      { find: "https://esm.town/v/std/oauth/middleware.ts", replacement: file("tests/support/oauth-middleware.ts") },
      { find: "https://esm.town/v/std/utils/index.ts", replacement: file("tests/support/val-utils.ts") },
    ],
  },
  server: { host: "127.0.0.1", port: 4180, strictPort: true, fs: { allow: [repoRoot] } },
  plugins: [{
    name: "synthetic-budget-api",
    configureServer(vite) {
      vite.middlewares.use(async (incoming, outgoing, next) => {
        if (!incoming.url?.startsWith("/api/") && incoming.url !== "/__test/reset") return next();
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(incoming.socket.remoteAddress)) {
          outgoing.writeHead(403); outgoing.end(); return;
        }
        try {
          if (incoming.url === "/__test/reset") {
            if (incoming.method !== "POST" || incoming.headers["x-budget-test-reset"] !== "synthetic-only") {
              outgoing.writeHead(403); outgoing.end(); return;
            }
            const { ensureSchema } = await vite.ssrLoadModule(file("server/db.ts"));
            await ensureSchema();
            database.exec("PRAGMA foreign_keys = OFF");
            database.exec("BEGIN");
            try {
              const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all();
              for (const { name } of tables) database.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
              database.exec("COMMIT");
            } catch (error) { database.exec("ROLLBACK"); throw error; }
            finally { database.exec("PRAGMA foreign_keys = ON"); }
            outgoing.writeHead(204); outgoing.end(); return;
          }
          const chunks = [];
          for await (const chunk of incoming) chunks.push(chunk);
          const headers = new globalThis.Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          // Mock only OAuth, using a test cookie. Production has no bypass.
          headers.delete("X-Test-User");
          const user = headers.get("cookie")?.match(/(?:^|;\s*)budget_e2e_user=([^;]*)/)?.[1];
          if (user) headers.set("X-Test-User", decodeURIComponent(user));
          const body = Buffer.concat(chunks);
          const request = new globalThis.Request(`http://127.0.0.1:4180${incoming.url}`, {
            method: incoming.method, headers,
            body: ["GET", "HEAD"].includes(incoming.method) ? undefined : body,
          });
          const response = await handler(request);
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          // Never log financial payloads or arbitrary route errors.
          outgoing.writeHead(500); outgoing.end("Synthetic harness request failed");
        }
      });
    },
  }],
});

const { useTestSqlite } = await server.ssrLoadModule(file("tests/support/val-sqlite.ts"));
useTestSqlite(database);
const { default: handler } = await server.ssrLoadModule(file("index.http.ts"));
await server.listen();
console.log("Synthetic BudgetApp browser harness ready on loopback");

async function close() { await server.close(); database.close(); process.exit(0); }
process.once("SIGTERM", close);
process.once("SIGINT", close);
