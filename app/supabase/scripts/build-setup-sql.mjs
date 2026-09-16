#!/usr/bin/env node
/**
 * Rebuild setup.sql from migrations/.
 *
 * The one-paste file exists because recreating this database is a thing someone
 * does under time pressure, having just discovered the old project is gone. Ten
 * files pasted in the right order is an opportunity to paste them in the wrong
 * one; the concatenation removes that.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const head = readFileSync(join(here, "..", "setup.sql"), "utf8").split("-- ─")[0];
/**
 * Make every CREATE POLICY re-runnable.
 *
 * The migrations are written to run once each, in order, so most use
 * `if not exists` but the policies do not — and Postgres has no
 * `create policy if not exists`. Pasting this file a second time (which is
 * exactly what someone does after a half-finished first attempt) would then
 * stop dead on "policy already exists", having applied only part of the file.
 *
 * So each one gets a matching DROP in front of it. Both spellings appear in the
 * migrations, and the table can sit on the same line or the next.
 */
function idempotentPolicies(sql) {
  return sql.replace(
    /^([ \t]*)create\s+policy\s+("[^"]+")\s*(?:\n\s*)?on\s+([A-Za-z0-9_.]+)/gim,
    (match, indent, name, table) =>
      `${indent}drop policy if exists ${name} on ${table};\n${match}`,
  );
}

const body = files
  .map((f) => {
    const rule = "-- " + "─".repeat(61);
    const sql = idempotentPolicies(readFileSync(join(dir, f), "utf8").trim());
    return `${rule}\n-- ${f}\n${rule}\n\n${sql}\n`;
  })
  .join("\n");

writeFileSync(join(here, "..", "setup.sql"), head + body);
console.log(`setup.sql rebuilt from ${files.length} migrations`);
