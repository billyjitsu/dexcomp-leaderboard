// Applies db/schema.sql (idempotent).   npm run db:migrate
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (run with --env-file=.env.local)");
const sql = neon(url);

// The HTTP driver runs one statement per query: strip comments, then split on ";".
const text = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8")
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");
const statements = text.split(";").map((s) => s.trim()).filter(Boolean);
for (const s of statements) await sql.query(s);
const tables = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
console.log(`applied ${statements.length} statements; tables: ${tables.map((t) => t.table_name).join(", ")}`);
