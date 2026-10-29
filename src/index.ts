/**
 * The Pawabase function kit for TypeScript: what a deployed `functions/*.ts` imports as `"@pawabase/functions"` (the platform also accepts the short name `"pawabase"`).
 *
 *   import { fn, FunctionError } from "@pawabase/functions";
 *
 *   export const create = fn("orders.create", { policy: "authenticated" }, async (ctx) => {
 *     return await ctx.runtime.resourceCreate("orders", ctx.input);
 *   });
 *
 * It mirrors the Python kit: a name, a policy, an input, `auth`, and `ctx.runtime` for data, events, secrets, storage and outbound HTTP —
 * every runtime call goes back to the platform, which answers it with the caller's identity (this process has no network of its own).
 *
 * **HTTP functions** are the other kind, written the way Supabase Edge Functions are: one folder per function, `functions/<name>/index.ts`,
 * answering any method and any sub-path of `/functions/v1/<name>/…` with a standard `Response`:
 *
 *   import { serve } from "@pawabase/functions";
 *
 *   export const config = { auth: "user", timeout: 60, cors: true };
 *
 *   serve(async (req, ctx) => {
 *     const { name } = await req.json();
 *     ctx.waitUntil(ctx.runtime.emit("greeted", { name }));
 *     return Response.json({ message: `Hello ${name}`, user: ctx.auth.user_id });
 *   });
 *
 * `Deno.serve(handler)` works too, unchanged (`getContext(req)` then gives the same `ctx`). Secrets are environment variables
 * (`Deno.env.get("STRIPE_KEY")`), `fetch()` goes out through the platform's guard, and `EdgeRuntime.waitUntil(promise)` is available for
 * code written for Supabase.
 */

export type Policy = string | Record<string, unknown> | null;

export interface FunctionOptions {
  description?: string;
  policy?: Policy;
  /** Seconds a call may take: it may only be shorter than the project's limit, which also caps memory and CPU. */
  timeout?: number;
  input_fields?: Record<string, unknown>[];
  tags?: string[];
}

export interface Context {
  input: any;
  auth: Record<string, any>;
  env: string;
  project: string;
  branch: string;
  trigger: string;
  request: any;
  runtime: Runtime;
  /** Lines recorded with the run, shown in Studio. */
  log: (...parts: unknown[]) => void;
}

export type Handler = (ctx: Context) => Promise<unknown> | unknown;

export interface FunctionSpec extends Required<Omit<FunctionOptions, "input_fields">> {
  name: string;
  /** Where `fn(...)` was called: the file URL and line, for Studio's code view. */
  location: { url: string; line: number } | null;
  input_fields: Record<string, unknown>[] | null;
  handler: Handler;
}

/** A failure the function chooses: the caller receives this status, code and message. */
export class FunctionError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(message: string, options: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.status = options.status ?? 400;
    this.code = options.code ?? "error";
    this.details = options.details ?? null;
  }
}

const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const registry: Map<string, FunctionSpec> = ((globalThis as any).__pawabase_registry ??= new Map());

/** Register a function. `fn(name, handler)` or `fn(name, options, handler)`. Returns the handler. */
export function fn(name: string, optionsOrHandler: FunctionOptions | Handler, maybeHandler?: Handler): Handler {
  const options = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
  if (!NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a valid function name`);
  if (typeof handler !== "function") throw new Error(`function ${name} needs a handler`);
  if (registry.has(name)) throw new Error(`function ${name} is defined twice`);
  registry.set(name, {
    name,
    location: caller(),
    handler,
    description: options.description ?? "",
    policy: options.policy === undefined ? "authenticated" : options.policy,
    timeout: options.timeout ?? 30,
    input_fields: options.input_fields ?? null,
    tags: options.tags ?? [],
  });
  return handler;
}

/** The file and line that called `fn` (the first stack frame outside this kit). */
function caller(): { url: string; line: number } | null {
  const here = import.meta.url;
  for (const frame of (new Error().stack || "").split("\n").slice(1)) {
    const match = frame.match(/(file:\/\/[^\s()]+):(\d+):\d+/);
    if (match && match[1] !== here) return { url: match[1], line: Number(match[2]) };
  }
  return null;
}

// ── values across the boundary (the Python kit's tagged JSON) ─────────────

export function encode(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { $dt: value.toISOString() };
  if (value instanceof Uint8Array) return { $b64: btoa(String.fromCharCode(...value)) };
  if (value instanceof Set) return { $set: [...value].map(encode) };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, encode(v)]));
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as object);
    if (entries.length === 1) {
      const [tag, inner] = entries[0];
      if (tag === "$b64") return Uint8Array.from(atob(inner as string), (c) => c.charCodeAt(0));
      if (tag === "$dt" || tag === "$date" || tag === "$dec") return inner; // ISO text, exact decimal text
      if (tag === "$set") return (inner as unknown[]).map(decode);
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

// ── ctx.runtime ───────────────────────────────────────────────────────────

export type Call = (method: string, args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;

/** `ctx.runtime`: one method per platform capability. `call` reaches any runtime method by its Python name. */
export class Runtime {
  #call: Call | undefined;
  constructor(call?: Call) {
    this.#call = call;
  }
  call(method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.#call) return Promise.reject(new Error("this runtime has no connection to a platform"));
    return this.#call(method, args, kwargs);
  }
  // data
  resourceList(resource: string, options: { filters?: unknown; sort?: string; limit?: number; offset?: number } = {}) {
    return this.call("resource_list", [resource], options);
  }
  resourceGet(resource: string, id: unknown) { return this.call("resource_get", [resource, id]); }
  resourceCreate(resource: string, data: Record<string, unknown>) { return this.call("resource_create", [resource, data]); }
  resourceUpdate(resource: string, id: unknown, data: Record<string, unknown>) { return this.call("resource_update", [resource, id, data]); }
  resourceDelete(resource: string, id: unknown) { return this.call("resource_delete", [resource, id]); }
  dbQuery(sql: string, params: unknown[] = []) { return this.call("db_query", [sql, params]); }
  dbTransaction(operations: Record<string, unknown>[]) { return this.call("db_transaction", [operations]); }
  // cache
  cacheGet(key: string) { return this.call("cache_get", [key]); }
  cacheSet(key: string, value: unknown, options: { ttl?: number; tags?: string[] } = {}) { return this.call("cache_set", [key, value], options); }
  cacheDelete(key: string) { return this.call("cache_delete", [key]); }
  cacheInvalidate(tags: string[]) { return this.call("cache_invalidate", [tags]); }
  // automation
  emit(name: string, payload: unknown = {}) { return this.call("emit", [name, payload]); }
  callFlow(flow: string, input: unknown = {}) { return this.call("call_flow", [flow, input]); }
  dispatchFlow(flow: string, input: unknown = {}, options: { delay?: number; queue?: string } = {}) { return this.call("dispatch_flow", [flow, input], options); }
  callFunction(name: string, input: unknown = {}) { return this.call("call_function", [name, input]); }
  dispatchFunction(name: string, input: unknown = {}, options: { delay?: number; queue?: string } = {}) { return this.call("dispatch_function", [name, input], options); }
  webhookSend(event: string, payload: unknown = {}) { return this.call("webhook_send", [event, payload]); }
  publish(channel: string, event: string, payload: unknown = {}) { return this.call("publish", [channel, event, payload]); }
  sendMail(to: string | string[], subject: string, options: { text?: string; html?: string; template?: string; data?: unknown } = {}) {
    return this.call("send_mail", [to, subject], options);
  }
  // storage
  storagePut(bucket: string, key: string, content: Uint8Array | string, contentType = "") {
    return this.call("storage_put", [bucket, key, typeof content === "string" ? new TextEncoder().encode(content) : content, contentType]);
  }
  storageRead(bucket: string, key: string, limit?: number) { return this.call("storage_read", limit ? [bucket, key, limit] : [bucket, key]); }
  storageSignedUrl(bucket: string, key: string, method = "GET", expiresIn = 300) { return this.call("storage_signed_url", [bucket, key, method, expiresIn]); }
  storageDelete(bucket: string, key: string) { return this.call("storage_delete", [bucket, key]); }
  // platform
  secret(name: string) { return this.call("secret", [name]) as Promise<string | null>; }
  identityUser(userId: string) { return this.call("identity_user", [userId]); }
  checkPolicy(ref: unknown, context: Record<string, unknown>) { return this.call("check_policy", [ref, context]); }
  metric(name: string, value = 1, tags?: Record<string, string>) { return this.call("metric", [name, value, tags ?? null]); }
  /** Outbound HTTP, made by the platform through its guard (private addresses are refused). */
  httpRequest(method: string, url: string, options: { headers?: Record<string, string>; json?: unknown; params?: Record<string, string>; timeout?: number; retries?: number } = {}) {
    return this.call("http_request", [method, url], options);
  }
}

// ── HTTP functions ────────────────────────────────────────────────────────

/** Who may call an HTTP function. */
export type HttpAuth =
  /** Anyone, without an API key: `/functions/v1/public/<env>/<name>` (webhooks from other services). */
  | "public"
  /** Any valid API key of the environment, signed in or not (the default, like Supabase's `verify_jwt` with the anon key). */
  | "key"
  /** A signed-in user (an access token in `Authorization: Bearer …`). */
  | "user"
  /** A secret key only (server-to-server). */
  | "service"
  /** Any other policy name or condition, evaluated like a resource policy. */
  | string
  | Record<string, unknown>;

export interface CorsConfig {
  /** Allowed origins; `"*"` for any (the default when `cors: true`). */
  origins?: string[] | "*";
  methods?: string[];
  headers?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/** `export const config = {...}` beside an HTTP function's handler. Every field is optional. */
export interface HttpFunctionConfig {
  description?: string;
  auth?: HttpAuth;
  /** Seconds a request may run. It may only be shorter than the project's limit; memory, CPU, body size and workers are the
   * project's (set by whoever operates the installation), not the function's. */
  timeout?: number;
  /** Workers kept running while idle, so a request never waits for a cold start (never more than the project allows). */
  warm?: number;
  /** Requests one worker serves at once before another is started. */
  concurrency?: number;
  /** Answer preflight requests and add CORS headers to every response. */
  cors?: boolean | CorsConfig;
  /** Methods the function answers; others get 405 before it runs. Default: all. */
  methods?: string[];
  tags?: string[];
}

/** What an HTTP function's handler receives beside the request. */
export interface HttpContext {
  /** The caller, as policies see it: `authenticated`, `user_id`, `roles`, `permissions`, `org`, … */
  auth: Record<string, any>;
  env: string;
  branch: string;
  project: string;
  /** The function's name. */
  function: string;
  /** The gateway's request id: quote it to find the run in Studio. */
  requestId: string;
  /** The path after `/functions/v1/<name>` (`/` when there is none), and the query string's values. */
  path: string;
  query: URLSearchParams;
  /** The platform runtime, acting as the caller: data, events, cache, storage, mail, secrets, other functions. */
  runtime: Runtime;
  /** A line recorded with this run (`console.log` is recorded too). */
  log: (...parts: unknown[]) => void;
  /** Keep working after the response is sent, until the promise settles (bounded by the installation). */
  waitUntil: (promise: Promise<unknown>) => void;
  /** Aborted when the caller goes away or the request runs out of time. */
  signal: AbortSignal;
}

export type HttpHandler = (request: Request, ctx: HttpContext) => Response | Promise<Response>;

interface HttpRegistration {
  kind: "pawabase" | "deno";
  handler: (request: Request, extra: any) => Response | Promise<Response>;
}

const http: { current: HttpRegistration | null } = ((globalThis as any).__pawabase_http ??= { current: null });
const contexts: WeakMap<Request, HttpContext> = ((globalThis as any).__pawabase_contexts ??= new WeakMap());

/** Make this module an HTTP function. Call it once, at the top level of `functions/<name>/index.ts`. */
export function serve(handler: HttpHandler): void {
  if (typeof handler !== "function") throw new Error("serve() needs a handler: (request, ctx) => Response");
  if (http.current) throw new Error("serve() was called twice: an HTTP function has one handler");
  http.current = { kind: "pawabase", handler: (request, ctx) => handler(request, ctx) };
}

/** The context of a request an HTTP function is answering: for handlers written with `Deno.serve`, which receive only the request. */
export function getContext(request: Request): HttpContext {
  const found = contexts.get(request);
  if (!found) throw new Error("getContext() is only available for the request an HTTP function is answering");
  return found;
}

/** Answer with JSON. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Answer with an error in the platform's shape: `{ error, message, details }`. */
export function errorResponse(status: number, code: string, message: string, details: unknown = null): Response {
  return json({ error: code, message, details }, { status });
}

/** Server-sent events: `return sse(async (send) => { send({ event: "tick", data: 1 }); })`. The stream ends when the callback returns. */
export function sse(
  producer: (send: (event: { event?: string; data: unknown; id?: string; retry?: number }) => void, signal: AbortSignal) => Promise<void> | void,
  init: ResponseInit & { signal?: AbortSignal } = {},
): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  init.signal?.addEventListener("abort", () => controller.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(out) {
      const send = (event: { event?: string; data: unknown; id?: string; retry?: number }) => {
        let text = "";
        if (event.id !== undefined) text += `id: ${event.id}\n`;
        if (event.event) text += `event: ${event.event}\n`;
        if (event.retry !== undefined) text += `retry: ${event.retry}\n`;
        const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
        for (const line of data.split("\n")) text += `data: ${line}\n`;
        out.enqueue(encoder.encode(text + "\n"));
      };
      try {
        await producer(send, controller.signal);
      } finally {
        try {
          out.close();
        } catch {
          // the reader went away first
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  return new Response(stream, { ...init, headers });
}

export { contexts as __contexts, http as __http, registry };
