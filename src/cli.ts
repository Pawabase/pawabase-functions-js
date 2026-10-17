#!/usr/bin/env node
/**
 * `pawabase-functions`: create, deploy and call TypeScript functions.
 *
 *   pawabase-functions init            scaffold functions/hello/index.ts (an HTTP function), a test and .env.example
 *   pawabase-functions new orders      another HTTP function (--fn: an fn() function instead)
 *   pawabase-functions serve           run the functions locally, with --watch (needs Deno)
 *   pawabase-functions deploy          bundle ./functions, upload and activate it
 *   pawabase-functions functions       what is deployed
 *   pawabase-functions invoke hello -d '{"name":"Ada"}'
 *   pawabase-functions deployments     history; `rollback <id>` activates an earlier one
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { ApiError, createClient } from "@pawabase/client";
import { manage, type Manage } from "@pawabase/client/manage";
import { BundleError, RESERVED, build, httpFunctions } from "./bundle.js";
import { SettingsError, load, redact, require as need } from "./config.js";

export const VERSION = "0.1.0";
const PRODUCTION = new Set(["production", "prod", "live"]);

const HELLO = `import { serve } from "@pawabase/functions";

// Who may call it: "key" (any API key, the default), "user" (a signed-in user), "service" (a secret key),
// "public" (anyone, at /functions/v1/public/<env>/hello), or a policy name.
export const config = { auth: "key", timeout: 30 };

serve(async (req, ctx) => {
  const name = ctx.query.get("name") ?? (req.method === "POST" ? (await req.json()).name : null) ?? "world";
  ctx.log("greeting", name);
  return Response.json({ message: \`Hello, \${name}!\`, user: ctx.auth.user_id ?? null });
});
`;

const HELLO_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { callHttp } from "@pawabase/functions/testing";

test("hello greets by name", async () => {
  const { response } = await callHttp("functions/hello/index.ts", "http://local/functions/v1/hello?name=Ada");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { message: "Hello, Ada!", user: null });
});
`;

function httpTemplate(name: string): string {
  return `import { serve, FunctionError } from "@pawabase/functions";

export const config = { auth: "key" };

serve(async (req, ctx) => {
  switch (req.method) {
    case "GET":
      return Response.json({ function: "${name}", path: ctx.path });
    case "POST": {
      const body = await req.json();
      return Response.json({ received: body }, { status: 201 });
    }
    default:
      throw new FunctionError(\`\${req.method} is not supported\`, { status: 405, code: "method_not_allowed" });
  }
});
`;
}

function fnTemplate(name: string): string {
  return `import { fn } from "@pawabase/functions";

export const ${name.replace(/[^A-Za-z0-9_]/g, "_")} = fn("${name}", { policy: "authenticated" }, async (ctx) => {
  return { input: ctx.input, user: ctx.auth.user_id ?? null };
});
`;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

export interface Io {
  out(text: string): void;
  err(text: string): void;
  confirm(question: string): Promise<boolean>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
}

const real: Io = {
  out: (text) => void process.stdout.write(text + "\n"),
  err: (text) => void process.stderr.write(text + "\n"),
  confirm: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(question)).trim());
    } finally {
      rl.close();
    }
  },
  cwd: process.cwd(),
  env: process.env,
  interactive: Boolean(process.stdin.isTTY),
};

const OPTIONS = {
  url: { type: "string" },
  "api-key": { type: "string" },
  environment: { type: "string", short: "e" },
  branch: { type: "string" },
  dir: { type: "string" },
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  "allow-secrets": { type: "boolean" },
  data: { type: "string", short: "d" },
  fn: { type: "boolean" },
  port: { type: "string" },
  "as-user": { type: "string" },
  role: { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

const HELP = `pawabase-functions ${VERSION}

  init [dir]           scaffold functions/hello/index.ts (an HTTP function), a test and .env.example
  new <name>           another HTTP function, functions/<name>/index.ts      [--fn: an fn() function]
  serve                run the functions locally at http://localhost:54321    [--port n] (needs Deno; restarts on change)
  whoami               show the resolved settings
  deploy               bundle ./functions, upload and activate it   [--dry-run] [--force] [--branch b] [-y]
  functions            list deployed functions
  invoke <name>        run a deployed function                      [-d '{"json":1}'|@file] [--as-user id --role r]
  deployments          deployment history
  rollback <id>        activate an earlier deployment

  --url --api-key -e/--environment --branch --dir --json
Settings: flags, PAWABASE_URL / PAWABASE_API_KEY / PAWABASE_ENVIRONMENT, .env, pawabase.toml.`;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function settingsOf(io: Io, values: Values) {
  const settings = load(io.cwd, { url: values.url, apiKey: values["api-key"], environment: values.environment, branch: values.branch, functions: values.dir }, io.env);
  need(settings, "url", "apiKey");
  return settings;
}

function managerOf(settings: ReturnType<typeof load>): { m: Manage; dispose: () => void } {
  const client = createClient({ url: settings.url, apiKey: settings.apiKey, environment: settings.environment, retry: { retries: 2 } });
  return { m: manage(client), dispose: () => client.dispose() };
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    // A refused deployment lists each problem, flat or under `detail`.
    const body = error.body as { problems?: unknown[]; detail?: { problems?: unknown[] } } | null | undefined;
    const found = body?.problems ?? body?.detail?.problems;
    const problems = Array.isArray(found) ? found.map((p) => `\n  - ${String(p)}`).join("") : "";
    return `${error.message}${problems}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function readData(io: Io, text: string | undefined): unknown {
  if (text === undefined) return {};
  const raw = text.startsWith("@") ? readFileSync(resolve(io.cwd, text.slice(1)), "utf8") : text;
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError("--data is not valid JSON.", 2);
  }
}

async function init(io: Io, positionals: string[]): Promise<number> {
  const root = resolve(io.cwd, positionals[0] ?? ".");
  const created: string[] = [];
  const files: Array<[string, string]> = [
    ["functions/hello/index.ts", HELLO],
    ["tests/hello.test.ts", HELLO_TEST],
    [".env.example", "PAWABASE_URL=\nPAWABASE_API_KEY=pb_sk_...\nPAWABASE_ENVIRONMENT=development\n"],
  ];
  for (const [relative, content] of files) {
    const target = join(root, relative);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    created.push(relative);
  }
  const gitignore = join(root, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (!existing.split("\n").includes(".env")) {
    writeFileSync(gitignore, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + ".env\nnode_modules/\n");
    created.push(".gitignore");
  }
  io.out(created.length ? `Created ${created.join(", ")}` : "Nothing to create: it is already set up.");
  io.out("Next: npm install @pawabase/functions, put your key in .env, then `pawabase-functions deploy`.");
  return 0;
}

function createFunction(io: Io, name: string, fnStyle: boolean): number {
  if (fnStyle) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name)) throw new CliError(`"${name}" is not a function name.`, 2);
    const file = join(io.cwd, "functions", `${name.replace(/[.:]/g, "_")}.ts`);
    if (existsSync(file)) throw new CliError(`${file} already exists.`, 2);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fnTemplate(name));
    io.out(`Created ${file}: an fn() function, called with POST /functions/v1/${name}.`);
    return 0;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
    throw new CliError(`"${name}" cannot name an HTTP function: lowercase letters, digits, - and _ (it is a folder and a URL segment).`, 2);
  }
  if (RESERVED.has(name)) throw new CliError(`"${name}" is reserved by the platform.`, 2);
  const file = join(io.cwd, "functions", name, "index.ts");
  if (existsSync(file)) throw new CliError(`${file} already exists.`, 2);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, httpTemplate(name));
  io.out(`Created functions/${name}/index.ts: answers /functions/v1/${name} and everything below it.`);
  return 0;
}

/** The import map the local server runs with: the kit from this package, then the project's own `functions/deno.json` imports. */
function localImportMap(root: string): Record<string, unknown> {
  const kit = pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href;
  const imports: Record<string, string> = {};
  for (const name of ["deno.json", "import_map.json"]) {
    const file = join(root, "functions", name);
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { imports?: Record<string, string> };
    for (const [key, target] of Object.entries(parsed.imports ?? {})) {
      imports[key] = target.startsWith(".") ? pathToFileURL(resolve(root, "functions", target)).href + (target.endsWith("/") ? "/" : "") : target;
    }
  }
  imports["@pawabase/functions"] = kit;
  imports["pawabase"] = kit;
  return { imports };
}

async function serveLocally(io: Io, values: Values): Promise<number> {
  const settings = load(io.cwd, { url: values.url, apiKey: values["api-key"], environment: values.environment, branch: values.branch, functions: values.dir }, io.env);
  const deno = io.env["PAWABASE_DENO_PATH"] || "deno";
  const port = values.port ? Number(values.port) : 54321;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("--port must be a port number.", 2);
  const scratch = mkdtempSync(join(tmpdir(), "pawabase-serve-"));
  const map = join(scratch, "import_map.json");
  writeFileSync(map, JSON.stringify(localImportMap(settings.root)));
  const script = fileURLToPath(new URL("../deno/serve.ts", import.meta.url));
  const args = ["run", "--watch", "--allow-net", "--allow-read", "--allow-env", "--no-prompt", `--import-map=${map}`, script, settings.root, String(port)];
  const child = spawn(deno, args, {
    stdio: "inherit",
    env: {
      ...io.env,
      ...(settings.url ? { PAWABASE_URL: settings.url } : {}),
      ...(settings.apiKey ? { PAWABASE_API_KEY: settings.apiKey } : {}),
      PAWABASE_ENVIRONMENT: settings.environment,
    },
  });
  return await new Promise<number>((resolveExit) => {
    child.on("error", () => {
      io.err("Deno is needed to serve functions locally: install it from https://deno.com (or set PAWABASE_DENO_PATH).");
      resolveExit(2);
    });
    child.on("exit", (code) => resolveExit(code ?? 0));
  });
}

async function deploy(io: Io, values: Values): Promise<number> {
  const settings = settingsOf(io, values);
  const packed = build({ root: settings.root, functions: settings.functions, allowSecrets: values["allow-secrets"] ?? false });
  const where = settings.environment + (settings.branch !== "main" ? ` @ ${settings.branch}` : "");
  io.out(`typescript: ${packed.files.length} files, ${(packed.archive.length / 1024).toFixed(1)} KB, checksum ${packed.checksum.slice(0, 12)}`);
  for (const name of packed.skipped.slice(0, 8)) io.out(`  skipped ${name}`);
  if (packed.skipped.length > 8) io.out(`  … and ${packed.skipped.length - 8} more skipped`);
  const http = httpFunctions(join(settings.root, settings.functions));
  if (http.length) io.out(`http functions: ${http.map((f) => f.name).join(", ")}`);
  io.out("The functions are loaded and checked by the deployment, not on this machine.");
  if (values["dry-run"]) {
    io.out(`Dry run: would deploy to ${where}. Nothing was uploaded.`);
    if (values.json) io.out(JSON.stringify({ dry_run: true, files: packed.files.length, bytes: packed.archive.length, checksum: packed.checksum }));
    return 0;
  }
  if (PRODUCTION.has(settings.environment) && !values.yes) {
    if (!io.interactive) throw new CliError(`${settings.environment} is a production environment: pass --yes to deploy to it without asking.`, 2);
    if (!(await io.confirm(`Deploy to ${where}? [y/N] `))) throw new CliError("Cancelled.");
  }
  const { m, dispose } = managerOf(settings);
  try {
    if (!values.force) {
      const listed = await m.functions.deployments({ branch: settings.branch });
      const active = (listed["data"] as Array<Record<string, any>> | undefined)?.find((d) => d["status"] === "active");
      if (active && active["checksum"] === packed.checksum) {
        io.out(`No changes: deployment ${String(active["id"]).slice(0, 12)} is already active on ${where}. (--force deploys anyway)`);
        return 0;
      }
    }
    const manifest = { kit: VERSION, branch: settings.branch, files: packed.files.length, bytes: packed.totalBytes, functions: [], requirements: [] };
    const answer = await m.functions.deploy(packed.encoded, { branch: settings.branch, manifest, runtime: "deno" });
    const names = ((answer["functions"] as Array<{ name: string }> | undefined) ?? []).map((f) => f.name).sort();
    io.out(`Deployed to ${where} as ${String(answer["deployment"]?.id).slice(0, 12)}: ${names.length} functions live (${names.join(", ")}).`);
    if (values.json) io.out(JSON.stringify(answer));
    return 0;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`The deployment was refused.\n${describe(error)}`);
  } finally {
    dispose();
  }
}

async function main(argv: string[], io: Io = real): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.version) return io.out(VERSION), 0;
  if (values.help || !command) return io.out(HELP), command || values.help ? 0 : 2;
  try {
    switch (command) {
      case "init":
        return await init(io, rest);
      case "new": {
        const name = rest[0];
        if (!name) throw new CliError("new needs a name: pawabase-functions new orders", 2);
        return createFunction(io, name, Boolean(values.fn));
      }
      case "serve":
        return await serveLocally(io, values);
      case "whoami": {
        const settings = load(io.cwd, { url: values.url, apiKey: values["api-key"], environment: values.environment, branch: values.branch, functions: values.dir }, io.env);
        const info = { url: settings.url || "(not set)", environment: settings.environment, branch: settings.branch, api_key: redact(settings.apiKey), root: settings.root, functions: settings.functions, sources: settings.sources };
        if (values.json) io.out(JSON.stringify(info));
        else for (const [name, value] of Object.entries(info)) if (name !== "sources") io.out(`${name.padEnd(12)} ${value}  ${settings.sources[name === "api_key" ? "apiKey" : name] ? `(${settings.sources[name === "api_key" ? "apiKey" : name]})` : ""}`);
        return 0;
      }
      case "deploy":
        return await deploy(io, values);
      case "functions": {
        const settings = settingsOf(io, values);
        const { m, dispose } = managerOf(settings);
        try {
          const listed = await m.functions.list({ branch: settings.branch !== "main" ? settings.branch : undefined });
          const rows = (listed["data"] as Array<Record<string, any>> | undefined) ?? [];
          if (values.json) io.out(JSON.stringify(rows));
          else for (const row of rows) io.out(`${String(row["name"]).padEnd(28)} ${String(row["policy"] ?? "").padEnd(14)} ${row["description"] ?? ""}`);
          return 0;
        } finally {
          dispose();
        }
      }
      case "invoke": {
        const name = rest[0];
        if (!name) throw new CliError("invoke needs a function name.", 2);
        const input = readData(io, values.data);
        const settings = settingsOf(io, values);
        const asUser = values["as-user"] ? { authenticated: true, user_id: values["as-user"], kind: "user", roles: values.role ?? [], permissions: [] } : undefined;
        const { m, dispose } = managerOf(settings);
        try {
          const answer = await m.functions.run(name, input, { branch: settings.branch !== "main" ? settings.branch : undefined, asUser });
          io.out(JSON.stringify(answer, null, 2));
          return answer["status"] === "failed" ? 1 : 0;
        } finally {
          dispose();
        }
      }
      case "deployments": {
        const settings = settingsOf(io, values);
        const { m, dispose } = managerOf(settings);
        try {
          const listed = await m.functions.deployments({ branch: settings.branch });
          const rows = (listed["data"] as Array<Record<string, any>> | undefined) ?? [];
          if (values.json) io.out(JSON.stringify(rows));
          else for (const row of rows) io.out(`${String(row["id"]).slice(0, 12)}  ${String(row["status"]).padEnd(10)} ${String(row["checksum"] ?? "").slice(0, 12)}  ${row["created_at"] ?? ""}`);
          return 0;
        } finally {
          dispose();
        }
      }
      case "rollback": {
        const id = rest[0];
        if (!id) throw new CliError("rollback needs a deployment id (see `deployments`).", 2);
        const settings = settingsOf(io, values);
        if (PRODUCTION.has(settings.environment) && !values.yes) throw new CliError(`${settings.environment} is a production environment: pass --yes to roll it back.`, 2);
        const { m, dispose } = managerOf(settings);
        try {
          await m.functions.activate(id);
          io.out(`Activated ${id.slice(0, 12)} on ${settings.environment}.`);
          return 0;
        } finally {
          dispose();
        }
      }
      default:
        throw new CliError(`Unknown command "${command}". Try --help.`, 2);
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return error.code;
    }
    if (error instanceof SettingsError) {
      io.err(error.message);
      return 2;
    }
    if (error instanceof BundleError) {
      io.err(error.message);
      return 1;
    }
    io.err(describe(error));
    return 1;
  }
}

export { main };

if (process.argv[1] && /pawabase-functions$|cli\.js$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
