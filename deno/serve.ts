/**
 * `pawabase-functions serve`: the project's functions on this machine, the way the platform serves them.
 *
 *   deno run --watch --allow-net --allow-read --allow-env --import-map=<map> serve.ts <project> <port>
 *
 * HTTP functions (`functions/<name>/index.ts`) answer `/functions/v1/<name>/…` with any method; `fn()` functions answer
 * `POST /functions/v1/<name>` with `{ data }`. Their `ctx.runtime` calls go to the platform named by `PAWABASE_URL` /
 * `PAWABASE_API_KEY` / `PAWABASE_ENVIRONMENT` (the project's `.env`), through `/platform/v1/envs/<env>/runtime/call`, acting as the
 * caller whose access token the request carries (read, not verified: this is your machine). Without them, runtime calls fail with a
 * message saying what to set. `--watch` restarts the server when a file changes.
 */

import { __contexts as contexts, __http as http, decode, encode, FunctionError, registry, Runtime, type HttpContext } from "@pawabase/functions";

const [project, portText] = Deno.args;
const root = project.replace(/\/+$/, "");
const port = Number(portText || 54321);

// ── settings: the project's .env files, then the process environment ──────

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

for (const file of [`${root}/.env`, `${root}/functions/.env`]) {
  try {
    for (const [key, value] of Object.entries(parseDotenv(await Deno.readTextFile(file)))) {
      if (Deno.env.get(key) === undefined) Deno.env.set(key, value);
    }
  } catch {
    // no such file
  }
}
const platformUrl = (Deno.env.get("PAWABASE_URL") || "").replace(/\/+$/, "");
const apiKey = Deno.env.get("PAWABASE_API_KEY") || "";
const environment = Deno.env.get("PAWABASE_ENVIRONMENT") || "development";

// ── the platform runtime, remotely ────────────────────────────────────────

function runtimeFor(auth: Record<string, unknown>): Runtime {
  return new Runtime(async (method, args, kwargs) => {
    if (!platformUrl || !apiKey) {
      throw new FunctionError(`ctx.runtime.${method} needs the platform: set PAWABASE_URL and PAWABASE_API_KEY (a secret key) in .env`, {
        status: 503,
        code: "runtime_unavailable",
      });
    }
    const response = await fetch(`${platformUrl}/platform/v1/envs/${encodeURIComponent(environment)}/runtime/call`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: apiKey, authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ method, args: encode(args), kwargs: encode(kwargs), as_user: auth.authenticated ? auth : null }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new FunctionError(body.message || body.detail || `${method} failed`, { status: response.status, code: body.error || "runtime_error", details: body.details });
    }
    return decode(body.result);
  });
}

function authOf(request: Request): Record<string, unknown> {
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return { authenticated: false, user_id: null, kind: "anonymous", roles: [], permissions: [] };
  try {
    const payload = JSON.parse(atob(header.slice(7).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return {
      authenticated: true,
      user_id: payload.sub ?? null,
      kind: "user",
      email: payload.email ?? null,
      roles: payload.roles ?? [],
      permissions: payload.permissions ?? [],
      org: payload.org ?? null,
    };
  } catch {
    return { authenticated: false, user_id: null, kind: "anonymous", roles: [], permissions: [] };
  }
}

// ── loading the functions ────────────────────────────────────────────────

type Loaded = { handler: (request: Request, extra: any) => Response | Promise<Response>; kind: string; config: Record<string, any> };
const httpFunctions = new Map<string, Loaded>();
const problems: string[] = [];

const realServe = Deno.serve.bind(Deno);
Object.defineProperty(Deno, "serve", {
  configurable: true,
  writable: true,
  value: (...args: any[]) => {
    let handler: any;
    for (const arg of args) {
      if (typeof arg === "function") handler = arg;
      else if (arg && typeof arg === "object" && typeof arg.handler === "function") handler = arg.handler;
    }
    if (!handler) throw new TypeError("Deno.serve() needs a handler");
    http.current = { kind: "deno", handler };
    return { finished: new Promise(() => {}), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: "0.0.0.0", port: 0 } };
  },
});

const functionsDir = `${root}/functions`;
const entries: Deno.DirEntry[] = [];
for await (const entry of Deno.readDir(functionsDir)) entries.push(entry);
entries.sort((a, b) => (a.name < b.name ? -1 : 1));
for (const entry of entries) {
  if (entry.isFile && /\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !entry.name.includes(".test.")) {
    try {
      await import(`file://${functionsDir}/${entry.name}`);
    } catch (error) {
      problems.push(`functions/${entry.name}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (!entry.isDirectory || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
  for (const candidate of ["index.ts", "index.mts", "index.js", "index.mjs"]) {
    try {
      if (!(await Deno.stat(`${functionsDir}/${entry.name}/${candidate}`)).isFile) continue;
    } catch {
      continue;
    }
    http.current = null;
    try {
      const module = await import(`file://${functionsDir}/${entry.name}/${candidate}`);
      if (!http.current) problems.push(`functions/${entry.name}/${candidate}: it never calls serve() or Deno.serve()`);
      else httpFunctions.set(entry.name, { ...(http.current as any), config: module.config ?? {} });
    } catch (error) {
      problems.push(`functions/${entry.name}/${candidate}: ${error instanceof Error ? error.message : error}`);
    }
    break;
  }
}
http.current = null;

// ── serving ──────────────────────────────────────────────────────────────

function problem(status: number, code: string, message: string, details: unknown = null): Response {
  return Response.json({ error: code, message, details }, { status });
}

let counter = 0;

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/functions\/v1\/(?:public\/[^/]+\/)?([^/]+)(\/.*)?$/);
  if (!match) return problem(404, "not_found", "Functions are served at /functions/v1/<name>.");
  const [, name, rest] = match;
  const started = performance.now();
  const auth = authOf(request);
  const fn = httpFunctions.get(name);
  if (fn) {
    const methods: string[] | undefined = fn.config.methods;
    if (methods && !methods.map((m) => m.toUpperCase()).includes(request.method) && request.method !== "OPTIONS") {
      return problem(405, "method_not_allowed", `${name} answers ${methods.join(", ")}.`);
    }
    if (fn.config.auth === "user" && !auth.authenticated) return problem(401, "unauthenticated", "Sign in first: this function needs a user's access token.");
    const controller = new AbortController();
    const pending: Promise<unknown>[] = [];
    const ctx: HttpContext = {
      auth,
      env: environment,
      branch: "main",
      project: "local",
      function: name,
      requestId: `local-${++counter}`,
      path: rest || "/",
      query: url.searchParams,
      runtime: runtimeFor(auth),
      log: (...parts) => console.log(`[${name}]`, ...parts),
      waitUntil: (promise) => void pending.push(Promise.resolve(promise).catch((error) => console.error(`[${name}] waitUntil failed:`, error))),
      signal: controller.signal,
    };
    contexts.set(request, ctx);
    (globalThis as any).EdgeRuntime = { waitUntil: ctx.waitUntil };
    try {
      const response = await (fn.kind === "pawabase" ? fn.handler(request, ctx) : fn.handler(request, { remoteAddr: { hostname: "127.0.0.1", port: 0, transport: "tcp" } }));
      console.log(`${request.method} /functions/v1/${name}${rest || ""} → ${response.status} in ${(performance.now() - started).toFixed(1)} ms`);
      return response;
    } catch (error) {
      if (error instanceof FunctionError) return problem(error.status, error.code, error.message, error.details);
      console.error(`[${name}] failed:`, error);
      return problem(500, "function_error", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }
  const spec = registry.get(name);
  if (spec && request.method === "POST") {
    const text = await request.text();
    let input: unknown = null;
    try {
      input = text ? JSON.parse(text) : null;
    } catch {
      return problem(400, "bad_request", "the body must be JSON");
    }
    try {
      const result = await spec.handler({
        input,
        auth,
        env: environment,
        project: "local",
        branch: "main",
        trigger: "http",
        request: { method: request.method, path: url.pathname },
        runtime: runtimeFor(auth),
        log: (...parts) => console.log(`[${name}]`, ...parts),
      });
      console.log(`POST /functions/v1/${name} → 200 in ${(performance.now() - started).toFixed(1)} ms`);
      return Response.json({ data: result ?? null });
    } catch (error) {
      if (error instanceof FunctionError) return problem(error.status, error.code, error.message, error.details);
      console.error(`[${name}] failed:`, error);
      return problem(500, "function_error", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }
  return problem(404, "not_found", `There is no function ${JSON.stringify(name)} in this project.`);
}

for (const line of problems) console.error(`✗ ${line}`);
const names = [...httpFunctions.keys()];
console.log(`Serving ${names.length} HTTP function(s) and ${registry.size} fn() function(s) on http://localhost:${port}/functions/v1/`);
for (const name of names) console.log(`  http   ${name.padEnd(24)} http://localhost:${port}/functions/v1/${name}`);
for (const name of registry.keys()) console.log(`  fn()   ${name}`);
console.log(platformUrl ? `ctx.runtime → ${platformUrl} (${environment})` : "ctx.runtime is not connected: set PAWABASE_URL and PAWABASE_API_KEY in .env");
realServe({ port, hostname: "127.0.0.1", onListen() {} }, handle);
