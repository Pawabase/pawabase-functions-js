/**
 * Testing functions without a Pawabase, a network or a database.
 *
 * ```ts
 * import { FakeRuntime, call } from "@pawabase/functions/testing";
 * import "../functions/stock.js";
 *
 * const runtime = new FakeRuntime({ secrets: { STRIPE_KEY: "sk_test" } });
 * await runtime.resourceCreate("stock", { id: 1, sku: "A", on_hand: 3 });
 * const result = await call("stock.reserve", { sku: "A", n: 2 }, { runtime });
 * assert.equal(result.ok, true);
 * assert.deepEqual(runtime.emitted, [["stock.reserved", { sku: "A", n: 2 }]]);
 * ```
 *
 * {@link FakeRuntime} is a complete `ctx.runtime`: an in-memory resource store, a cache, secrets you give it, and recorders for everything that
 * leaves the function (events, queued flows and functions, realtime messages, mail, outbound HTTP, storage writes).
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  FunctionError,
  Runtime,
  __contexts as contexts,
  __http as http,
  registry,
  type Context,
  type Handler,
  type HttpContext,
  type HttpHandler,
} from "./index.js";

export interface FakeRuntimeOptions {
  /** Rows by resource name. */
  resources?: Record<string, Array<Record<string, any>>>;
  secrets?: Record<string, string>;
  /** Answers for outbound HTTP, keyed `"GET https://example.com/x"`, or a function of the call. */
  http?: Record<string, unknown> | ((method: string, url: string, options: Record<string, any>) => unknown);
  /** Answers `dbQuery` (there is no SQL engine here): a function of the statement and parameters. */
  sql?: (statement: string, params: unknown[]) => unknown;
  users?: Record<string, Record<string, unknown>>;
  /** Flows `callFlow` returns for, by name. */
  flows?: Record<string, (input: any) => unknown>;
  /** Functions `callFunction` returns for, by name (functions in the registry are called for real when not listed). */
  functions?: Record<string, (input: any) => unknown>;
}

type Row = Record<string, any>;

export class FakeRuntime extends Runtime {
  readonly resources: Map<string, Row[]> = new Map();
  readonly cache: Map<string, unknown> = new Map();
  readonly secrets: Record<string, string>;
  readonly emitted: Array<[string, unknown]> = [];
  readonly dispatched: Array<{ kind: "flow" | "function"; name: string; input: unknown; options: Record<string, unknown> }> = [];
  readonly published: Array<{ channel: string; event: string; payload: unknown }> = [];
  readonly mail: Array<{ to: string[]; subject: string; options: Record<string, unknown> }> = [];
  readonly httpCalls: Array<{ method: string; url: string; options: Record<string, unknown> }> = [];
  readonly stored: Map<string, Uint8Array> = new Map();
  readonly webhooks: Array<[string, unknown]> = [];
  readonly metrics: Array<{ name: string; value: number; tags: unknown }> = [];

  private nextId = 1;
  private readonly options: FakeRuntimeOptions;

  constructor(options: FakeRuntimeOptions = {}) {
    super();
    this.options = options;
    this.secrets = { ...options.secrets };
    for (const [name, rows] of Object.entries(options.resources ?? {})) this.resources.set(name, rows.map((row) => ({ ...row })));
  }

  override async call(method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    const rows = (name: string) => this.resources.get(name) ?? (this.resources.set(name, []), this.resources.get(name)!);
    const [a, b, c] = args as any[];
    switch (method) {
      case "resource_list": {
        let found = rows(a);
        for (const [field, value] of Object.entries((kwargs["filters"] as Row | undefined) ?? {})) found = found.filter((row) => row[field] === value);
        const offset = Number(kwargs["offset"] ?? 0);
        const limit = Number(kwargs["limit"] ?? 50);
        return { data: found.slice(offset, offset + limit).map((row) => ({ ...row })), total: found.length };
      }
      case "resource_get": {
        const row = rows(a).find((r) => r["id"] === b);
        return row ? { ...row } : null; // a copy, as over the wire: changing it does not change the store
      }
      case "resource_create": {
        const row = { id: this.nextId++, ...b };
        rows(a).push(row);
        return { ...row };
      }
      case "resource_update": {
        const row = rows(a).find((r) => r["id"] === b);
        if (!row) return null;
        Object.assign(row, c);
        return { ...row };
      }
      case "resource_delete": {
        const list = rows(a);
        const at = list.findIndex((r) => r["id"] === b);
        if (at < 0) return false;
        list.splice(at, 1);
        return true;
      }
      case "db_query":
        if (!this.options.sql) throw new Error("FakeRuntime has no SQL engine: pass `sql: (statement, params) => rows` to answer dbQuery.");
        return this.options.sql(a, (b as unknown[]) ?? []);
      case "cache_get":
        return this.cache.get(a) ?? null;
      case "cache_set":
        this.cache.set(a, b);
        return null;
      case "cache_delete":
        return this.cache.delete(a);
      case "cache_invalidate":
        return 0;
      case "emit":
        this.emitted.push([a, b]);
        return `evt_${this.emitted.length}`;
      case "dispatch_flow":
      case "dispatch_function":
        this.dispatched.push({ kind: method === "dispatch_flow" ? "flow" : "function", name: a, input: b, options: kwargs });
        return `job_${this.dispatched.length}`;
      case "call_flow": {
        const flow = this.options.flows?.[a];
        if (!flow) throw new FunctionError(`no flow ${a} is stubbed: pass \`flows: { ${a}: input => result }\``, { status: 404, code: "not_found" });
        return flow(b);
      }
      case "call_function": {
        const stub = this.options.functions?.[a];
        if (stub) return stub(b);
        const spec = registry.get(a);
        if (!spec) throw new FunctionError(`no function ${a}`, { status: 404, code: "not_found" });
        return spec.handler(contextFor(this, b));
      }
      case "publish":
        this.published.push({ channel: a, event: b, payload: c });
        return { ok: true };
      case "storage_put":
        this.stored.set(`${a}/${b}`, c instanceof Uint8Array ? c : new TextEncoder().encode(String(c)));
        return { bucket: a, key: b, size: (c as Uint8Array).length };
      case "storage_read": {
        const data = this.stored.get(`${a}/${b}`);
        if (!data) throw new FunctionError("object not found", { status: 404, code: "not_found" });
        return data;
      }
      case "storage_signed_url":
        return `https://files.test/${a}/${b}?signed=1`;
      case "storage_delete":
        return this.stored.delete(`${a}/${b}`);
      case "send_mail":
        this.mail.push({ to: Array.isArray(a) ? a : [a], subject: b, options: kwargs });
        return { queued: true };
      case "http_request": {
        this.httpCalls.push({ method: a, url: b, options: kwargs });
        const answers = this.options.http;
        if (typeof answers === "function") return answers(a, b, kwargs);
        const key = `${String(a).toUpperCase()} ${b}`;
        if (answers && key in answers) return answers[key];
        throw new Error(`FakeRuntime has no answer for ${key}: pass \`http: { "${key}": { status: 200, json: {} } }\``);
      }
      case "webhook_send":
        this.webhooks.push([a, b]);
        return 1;
      case "secret":
        return this.secrets[a] ?? null;
      case "identity_user":
        return this.options.users?.[a] ?? null;
      case "check_policy":
        return true;
      case "metric":
        this.metrics.push({ name: a, value: b ?? 1, tags: c ?? null });
        return null;
      default:
        throw new Error(`FakeRuntime does not implement runtime.${method}`);
    }
  }
}

export interface Auth {
  authenticated?: boolean;
  user_id?: string | null;
  kind?: string;
  roles?: string[];
  permissions?: string[];
  [key: string]: unknown;
}

export function anonymous(): Auth {
  return { authenticated: false, user_id: null, kind: "anonymous", roles: [], permissions: [] };
}

export function user(id: string, extra: Partial<Auth> = {}): Auth {
  return { authenticated: true, user_id: id, kind: "user", roles: [], permissions: [], ...extra };
}

function contextFor(runtime: Runtime, input: unknown, options: CallOptions = {}): Context {
  return {
    input,
    auth: (options.auth as Record<string, any>) ?? anonymous(),
    env: options.env ?? "test",
    project: options.project ?? "test",
    branch: options.branch ?? "main",
    trigger: options.trigger ?? "test",
    request: options.request ?? null,
    runtime,
    log: (...parts: unknown[]) => void options.logs?.push(parts),
  };
}

export interface CallOptions {
  runtime?: Runtime;
  auth?: Auth;
  env?: string;
  project?: string;
  branch?: string;
  trigger?: string;
  request?: unknown;
  /** Receives each `ctx.log(...)` line. */
  logs?: unknown[][];
}

export interface CallResult {
  ok: boolean;
  result?: unknown;
  /** What the caller would receive when the function fails. */
  error?: { status: number; code: string; message: string; details: unknown };
  logs: unknown[][];
}

/**
 * Run a registered function (by name) or a handler as the platform would: a {@link FunctionError} becomes a failed result with its status
 * and code, any other exception is a `500` the caller would see as `function_error`.
 */
export async function call(target: string | Handler, input: unknown = {}, options: CallOptions = {}): Promise<CallResult> {
  const handler = typeof target === "string" ? registry.get(target)?.handler : target;
  if (!handler) throw new Error(`no function named ${JSON.stringify(target)} is registered: import the file that defines it first`);
  const logs: unknown[][] = options.logs ?? [];
  const context = contextFor(options.runtime ?? new FakeRuntime(), input, { ...options, logs });
  try {
    return { ok: true, result: await handler(context), logs };
  } catch (error) {
    if (error instanceof FunctionError) {
      return { ok: false, error: { status: error.status, code: error.code, message: error.message, details: error.details }, logs };
    }
    return { ok: false, error: { status: 500, code: "function_error", message: error instanceof Error ? error.message : String(error), details: null }, logs };
  }
}

/** Forget every registered function (call between test files that define the same names). */
export function resetRegistry(): void {
  registry.clear();
}

// ── HTTP functions ────────────────────────────────────────────────────────

export interface HttpCallOptions {
  runtime?: Runtime;
  auth?: Auth;
  env?: string;
  branch?: string;
  project?: string;
  /** The function's name (its folder); defaults to the folder of the module. */
  function?: string;
  /** Environment variables the function reads with `Deno.env.get` (its secrets, in production). */
  variables?: Record<string, string>;
  requestId?: string;
}

export interface HttpCallResult {
  response: Response;
  /** What `ctx.log` and `console.*` recorded while the handler ran. */
  logs: unknown[][];
  /** Settles when the work handed to `ctx.waitUntil` (or `EdgeRuntime.waitUntil`) has settled. */
  background: Promise<void>;
  ctx: HttpContext;
}

let loads = 0;

function installDenoShim(variables: Record<string, string>) {
  const g = globalThis as any;
  if (g.Deno && !g.Deno.__pawabaseShim) {
    // Real Deno: only the handler capture is needed, as the platform does.
    if (!g.Deno.__pawabaseServe) {
      g.Deno.__pawabaseServe = true;
      Object.defineProperty(g.Deno, "serve", { value: denoServe, configurable: true, writable: true });
    }
    return;
  }
  g.Deno = {
    __pawabaseShim: true,
    serve: denoServe,
    env: {
      get: (name: string) => variables[name],
      has: (name: string) => name in variables,
      toObject: () => ({ ...variables }),
    },
  };
}

function denoServe(...args: any[]) {
  let handler: ((request: Request, info: any) => Response | Promise<Response>) | undefined;
  for (const arg of args) {
    if (typeof arg === "function") handler = arg;
    else if (arg && typeof arg === "object" && typeof arg.handler === "function") handler = arg.handler;
  }
  if (!handler) throw new TypeError("Deno.serve() needs a handler");
  http.current = { kind: "deno", handler };
  return { finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {}, addr: { hostname: "0.0.0.0", port: 0 } };
}

/**
 * Load an HTTP function's module (`functions/<name>/index.ts`) and return its handler. Each call imports the module afresh, so
 * several functions — or one function several times — can be loaded in one test process.
 */
export async function loadHttpFunction(
  modulePath: string,
  options: { variables?: Record<string, string> } = {},
): Promise<{ handler: (request: Request, ctx: HttpContext) => Promise<Response>; style: "pawabase" | "deno"; config: Record<string, unknown> }> {
  installDenoShim(options.variables ?? {});
  http.current = null;
  const url = pathToFileURL(resolve(modulePath)).href + `?pawabase-load=${++loads}`;
  const module = await import(url);
  const registration = http.current as { kind: "pawabase" | "deno"; handler: any } | null;
  http.current = null;
  if (!registration) throw new Error(`${modulePath} never calls serve() or Deno.serve()`);
  const handler = async (request: Request, ctx: HttpContext) => {
    contexts.set(request, ctx);
    return registration.kind === "pawabase"
      ? registration.handler(request, ctx)
      : registration.handler(request, { remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 0 }, completed: Promise.resolve() });
  };
  return { handler, style: registration.kind, config: module.config && typeof module.config === "object" ? module.config : {} };
}

/**
 * Send a request to an HTTP function, as the platform would: the function receives the request and a `ctx` with a fake runtime, and
 * its response comes back as a standard `Response`. A thrown `FunctionError` becomes a response in the platform's error shape, any other
 * exception a 500, exactly as deployed.
 *
 * ```ts
 * const { response } = await callHttp("functions/hello/index.ts", new Request("http://local/functions/v1/hello?name=Ada"));
 * assert.equal((await response.json()).message, "Hello Ada");
 * ```
 */
export async function callHttp(
  target: string | HttpHandler,
  request: Request | string,
  options: HttpCallOptions = {},
): Promise<HttpCallResult> {
  const req = typeof request === "string" ? new Request(request) : request;
  const loaded =
    typeof target === "string"
      ? await loadHttpFunction(target, { variables: options.variables })
      : { handler: async (r: Request, c: HttpContext) => target(r, c) };
  const name = options.function ?? (typeof target === "string" ? resolve(target).split(/[\\/]/).slice(-2, -1)[0] ?? "function" : "function");
  const url = new URL(req.url);
  const prefix = `/functions/v1/${name}`;
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "/" : url.pathname;
  const logs: unknown[][] = [];
  const pending: Promise<unknown>[] = [];
  const controller = new AbortController();
  const ctx: HttpContext = {
    auth: (options.auth as Record<string, any>) ?? anonymous(),
    env: options.env ?? "test",
    branch: options.branch ?? "main",
    project: options.project ?? "test",
    function: name,
    requestId: options.requestId ?? "test-request",
    path,
    query: url.searchParams,
    runtime: options.runtime ?? new FakeRuntime(),
    log: (...parts: unknown[]) => void logs.push(parts),
    waitUntil: (promise: Promise<unknown>) => void pending.push(Promise.resolve(promise).catch((error) => logs.push(["waitUntil failed:", error]))),
    signal: controller.signal,
  };
  const g = globalThis as any;
  const previous = g.EdgeRuntime;
  g.EdgeRuntime = { waitUntil: ctx.waitUntil };
  let response: Response;
  try {
    const result = await loaded.handler(req, ctx);
    if (!(result instanceof Response)) throw new TypeError("the handler must return a Response");
    response = result;
  } catch (error) {
    response =
      error instanceof FunctionError
        ? new Response(JSON.stringify({ error: error.code, message: error.message, details: error.details ?? null }), {
            status: error.status,
            headers: { "content-type": "application/json" },
          })
        : new Response(
            JSON.stringify({ error: "function_error", message: "The function failed before it answered.", details: { kind: (error as Error)?.name ?? "Error" } }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
    if (!(error instanceof FunctionError)) logs.push(["error:", error]);
  } finally {
    g.EdgeRuntime = previous;
  }
  return { response, logs, background: Promise.all(pending).then(() => undefined), ctx };
}

