import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { withPgClient } from "./postgres.js";

const currentFile = fileURLToPath(import.meta.url);
const serverRoot = path.resolve(path.dirname(currentFile), "../..");

export async function runMigrations(config = loadConfig()) {
  const migrationsDir = path.join(serverRoot, "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  return withPgClient(config, async (client) => {
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const appliedResult = await client.query("select version from schema_migrations");
    const applied = new Set(appliedResult.rows.map((row) => row.version));
    const executed = [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
        executed.push(file);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    return { executed, skipped: files.filter((file) => !executed.includes(file)) };
  });
}

if (process.argv[1] === currentFile) {
  runMigrations()
    .then((result) => {
      console.log(`Migrations complete. Executed: ${result.executed.length || 0}.`);
      if (result.executed.length) console.log(result.executed.join("\n"));
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
