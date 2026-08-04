import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const api = (path) => readFile(new URL(`../supabase/functions/api/${path}`, import.meta.url), "utf8");

test("серверная точка входа только запускает HTTP-модуль", async () => {
  const source = await api("index.ts");

  assert.match(source, /import \{ handleRequest \} from "\.\/http\.ts";/);
  assert.match(source, /Deno\.serve\(handleRequest\);/);
  assert.doesNotMatch(source, /createClient|TOCHKA_TOKEN|case "|findUser|readAll/);
});

test("доступ к Supabase остаётся внутри репозиториев", async () => {
  const paths = ["index.ts", "http.ts", "actions.ts", "bank.ts", "auth/access.ts", "db/repositories.ts"];
  const sources = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await api(path)])));

  assert.match(sources["db/repositories.ts"], /createClient\(/);
  for (const path of paths.filter((path) => path !== "db/repositories.ts")) {
    assert.doesNotMatch(sources[path], /createClient\(|\.from\("records"\)|\.rpc\(/, path);
  }
});

test("HTTP-модуль сохраняет полный набор действий и порядок банковской авторизации", async () => {
  const source = await api("http.ts");
  const actions = [
    "login", "status", "tochka_sync", "migrate_import", "bootstrap", "create", "update",
    "delete", "comment", "import_players", "mark_read", "resolve_expense", "upload_file", "get_file",
  ];

  for (const action of actions) assert.match(source, new RegExp(`["']${action}["']`), action);

  const start = source.indexOf('if (action === "tochka_sync")');
  const end = source.indexOf('if (action === "migrate_import")', start);
  const block = source.slice(start, end);
  assert.ok(block.indexOf("tochkaSyncAccess(") < block.indexOf('error: "auth"'));
  assert.ok(block.indexOf('error: "auth"') < block.indexOf("runTochkaSync("));
});

test("локальные импорты серверных модулей совместимы с Deno", async () => {
  const paths = ["index.ts", "http.ts", "actions.ts", "bank.ts", "auth/access.ts", "db/repositories.ts"];

  for (const path of paths) {
    const source = await api(path);
    assert.doesNotMatch(source, /from\s+["']node:/, path);
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:js\/|google-apps-script)/, path);
    for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      assert.match(match[1], /\.(?:ts|js)$/, `${path}: ${match[1]}`);
    }
  }
});

test("банковский модуль не выпускает исходные ошибки наружу", async () => {
  const source = await api("bank.ts");
  const start = source.indexOf("export async function runTochkaSync");
  const block = source.slice(start);

  assert.ok(start >= 0);
  assert.match(block, /error: "Синхронизация с Точка Банком не выполнена"/);
  assert.match(block, /LAST_SYNC_ERROR/);
  assert.doesNotMatch(block, /error\.message|console\.error|String\(_?error\)|throw\s+_?error/);
});
