import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FunctionError, serve } from "../src/index.js";
import { FakeRuntime, callHttp, loadHttpFunction, user } from "../src/testing.js";
import { build, httpFunctions, languageOf, read } from "../src/bundle.js";

const made: string[] = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const KIT = new URL("../src/index.js", import.meta.url).href;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pbfn-http-"));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content.replaceAll("@pawabase/functions", KIT));
  }
  return root;
}

test("callHttp runs a handler with a context and a fake runtime", async () => {
  const runtime = new FakeRuntime();
  const { response, background, logs } = await callHttp(
    async (req, ctx) => {
      ctx.log("hi", ctx.path);
      ctx.waitUntil(ctx.runtime.emit("seen", { path: ctx.path }));
      return Response.json({ user: ctx.auth.user_id, q: ctx.query.get("q"), method: req.method });
    },
    new Request("http://local/functions/v1/thing/a/b?q=1", { method: "PUT" }),
    { runtime, auth: user("u1"), function: "thing" },
  );
  assert.deepEqual(await response.json(), { user: "u1", q: "1", method: "PUT" });
  await background;
  assert.deepEqual(runtime.emitted, [["seen", { path: "/a/b" }]]);
  assert.deepEqual(logs, [["hi", "/a/b"]]);
});

test("a FunctionError becomes the platform's error shape; anything else a 500", async () => {
  const chosen = await callHttp(() => {
    throw new FunctionError("nope", { status: 409, code: "conflict" });
  }, "http://local/functions/v1/x");
  assert.equal(chosen.response.status, 409);
  assert.deepEqual(await chosen.response.json(), { error: "conflict", message: "nope", details: null });
  const broken = await callHttp(() => {
    throw new Error("kaput");
  }, "http://local/functions/v1/x");
  assert.equal(broken.response.status, 500);
});

test("modules written with serve() or Deno.serve() load, each afresh, with their config and variables", async () => {
  const root = project({
    "functions/hello/index.ts": `import { serve } from "@pawabase/functions";
export const config = { auth: "user" };
serve((req, ctx) => Response.json({ hello: ctx.function, path: ctx.path }));`,
    "functions/native/index.ts": `Deno.serve((req) => new Response(Deno.env.get("GREETING") ?? "none"));`,
  });
  const hello = await callHttp(join(root, "functions/hello/index.ts"), "http://local/functions/v1/hello/x");
  assert.deepEqual(await hello.response.json(), { hello: "hello", path: "/x" });
  const loaded = await loadHttpFunction(join(root, "functions/hello/index.ts"));
  assert.equal(loaded.style, "pawabase");
  assert.deepEqual(loaded.config, { auth: "user" });
  const native = await callHttp(join(root, "functions/native/index.ts"), "http://local/functions/v1/native", { variables: { GREETING: "hi" } });
  assert.equal(await native.response.text(), "hi");
});

test("serve() twice in one module is refused", () => {
  const g = globalThis as any;
  g.__pawabase_http.current = null;
  serve(() => new Response("a"));
  assert.throws(() => serve(() => new Response("b")), /twice/);
  g.__pawabase_http.current = null;
});

test("HTTP function folders make a TypeScript project, and bundle with their shared code", () => {
  const root = project({
    "functions/hello/index.ts": "export {};\n",
    "functions/_shared/util.ts": "export const x = 1;\n",
    "functions/notes.md": "just a note\n",
    "functions/deno.json": '{"imports": {"@lib/": "./_shared/"}}',
  });
  assert.equal(languageOf(join(root, "functions")), "typescript");
  assert.deepEqual(httpFunctions(join(root, "functions")), [{ name: "hello", entry: "functions/hello/index.ts" }]);
  const files = Object.keys(read(build({ root }).archive)).sort();
  assert.deepEqual(files, ["functions/_shared/util.ts", "functions/deno.json", "functions/hello/index.ts", "functions/notes.md"]);
});

test("reserved and invalid folder names stop the bundle", () => {
  const root = project({ "functions/public/index.ts": "export {};\n" });
  assert.throws(() => build({ root }), /reserved/);
});
