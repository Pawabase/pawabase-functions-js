# @pawabase/functions

Write, test and deploy [Pawabase](https://pawabase.com) functions in TypeScript. They run in a sandboxed Deno worker on the platform; a project's functions are
**one language**, so a project that deploys TypeScript has no Python functions.

```bash
npm install @pawabase/functions
npx pawabase-functions init          # functions/hello/index.ts, tests/hello.test.ts, .env.example
npx pawabase-functions serve         # run them at http://localhost:54321/functions/v1/… (needs Deno; restarts on change)
```

## HTTP functions

One folder per function, the way Supabase Edge Functions are laid out. `functions/<name>/index.ts` answers any method and any path under
`/functions/v1/<name>` with a standard `Response`, streamed:

```ts
// functions/orders/index.ts
import { serve } from "@pawabase/functions";

export const config = { auth: "user", timeout: 30, warm: 1 };   // auth: "key" (default) | "user" | "service" | "public" | a policy

serve(async (req, ctx) => {
  const order = await ctx.runtime.resourceCreate("orders", { ...(await req.json()), user_id: ctx.auth.user_id });
  ctx.waitUntil(ctx.runtime.emit("order.created", { id: order.id }));      // runs after the response
  return Response.json(order, { status: 201 });
});
```

`Deno.serve(handler)` works unchanged (`getContext(req)` gives the same `ctx`). Secrets are environment variables (`Deno.env.get`),
`npm:`/`jsr:`/URL imports are fetched once when you deploy, and `fetch()` goes through the platform's outbound guard. Test without a
platform:

```ts
import { callHttp, FakeRuntime, user } from "@pawabase/functions/testing";
const { response } = await callHttp("functions/orders/index.ts", new Request("http://local/functions/v1/orders", { method: "POST", body: "{}" }), {
  runtime: new FakeRuntime(), auth: user("u1"),
});
```

The full guide: [HTTP functions](https://docs.pawabase.com/code/http-functions).

## fn() functions

JSON in, JSON out at `POST /functions/v1/<name>`, also callable from flows, schedules and events:

```ts
// functions/orders.ts
import { fn, FunctionError } from "@pawabase/functions";

export const create = fn("orders.create", { policy: "authenticated", description: "Place an order" }, async (ctx) => {
  const stock = (await ctx.runtime.resourceGet("stock", ctx.input.sku)) as { on_hand: number } | null;
  if (!stock || stock.on_hand < ctx.input.qty) throw new FunctionError("Not enough stock.", { status: 409, code: "insufficient_stock" });
  const order = await ctx.runtime.resourceCreate("orders", { user_id: ctx.auth.user_id, ...ctx.input });
  await ctx.runtime.emit("order.created", { id: (order as { id: number }).id });
  return order;
});
```

A function has a **name**, a **policy** (`public`, `authenticated`, a role or permission, or a condition), an **input**, `ctx.auth` (who is calling), and
`ctx.runtime` for everything the platform offers: resources (`resourceList/Get/Create/Update/Delete`), SQL (`dbQuery`, `dbTransaction`), cache, events
(`emit`), flows and functions (`callFlow`, `dispatchFlow`, `callFunction`, `dispatchFunction`), realtime (`publish`), mail, storage, secrets, metrics and
outbound HTTP (`httpRequest`, made by the platform through its guard). Every runtime call goes back to the platform, which answers it with the caller's
identity: the worker has **no network, file or environment access of its own**.

Throw a `FunctionError(message, { status, code, details })` to choose what the caller receives. Any other exception is a `500 function_error`.

## Testing without a platform

```ts
import { FakeRuntime, call, user } from "@pawabase/functions/testing";
import "../functions/orders.js";

const runtime = new FakeRuntime({ resources: { stock: [{ id: "A1", on_hand: 3 }] } });
const result = await call("orders.create", { sku: "A1", qty: 2 }, { runtime, auth: user("u1") });
// result.ok, result.result, result.error, result.logs; runtime.emitted, .mail, .published, .dispatched, .httpCalls, .stored
```

`FakeRuntime` is an in-memory `ctx.runtime`: resources, a cache, the secrets you give it, and recorders for everything that leaves the function. It says what
it cannot answer (SQL, outbound HTTP, a flow) instead of guessing; give it `sql`, `http` or `flows` stubs.

## Deploying

```bash
export PAWABASE_URL=https://api.example.com PAWABASE_API_KEY=pb_sk_…   # or a .env file, or pawabase.toml for url/environment
npx pawabase-functions deploy --dry-run     # bundle and check; upload nothing
npx pawabase-functions deploy               # upload and activate
npx pawabase-functions deploy --branch feature-x -e staging
npx pawabase-functions functions            # what is deployed
npx pawabase-functions invoke orders.create -d '{"sku":"A1","qty":1}' --as-user u1
npx pawabase-functions deployments          # history;  rollback <id> activates an earlier one
```

The bundle is a reproducible archive of `functions/` (tests, hidden files and `node_modules` are left out; `package-lock.json` too), so an unchanged project is
reported as "No changes". Files that look like credentials, or source that contains a key, stop the deploy before anything is uploaded. Imports are
**local files only**: the platform does not fetch `npm:` or URL imports. Production environments ask for `--yes`. The functions are loaded and checked by the
deployment (Deno), and a deployment that does not load is refused with each problem listed, leaving the active one in place.

`src/index.ts` is the same file the platform runs (`pawabase_server/functions/sandbox/deno/pawabase.ts`), so what passes here behaves the same there.
