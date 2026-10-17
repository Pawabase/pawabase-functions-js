import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { FunctionError, Runtime, decode, encode, fn, registry } from "../src/index.js";
import { FakeRuntime, call, resetRegistry, user } from "../src/testing.js";

beforeEach(resetRegistry);

test("fn registers a function with its defaults and records where it was defined", () => {
  fn("orders.create", async () => 1);
  const spec = registry.get("orders.create")!;
  assert.equal(spec.policy, "authenticated");
  assert.equal(spec.timeout, 30);
  assert.ok(spec.location?.url.endsWith("kit.test.js") || spec.location?.url.includes("kit.test"), String(spec.location?.url));
  assert.ok((spec.location?.line ?? 0) > 0);
});

test("bad names, missing handlers and duplicates are refused", () => {
  assert.throws(() => fn("not a name", async () => 1), /not a valid function name/);
  assert.throws(() => fn("a", { policy: "public" } as never), /needs a handler/);
  fn("dup", async () => 1);
  assert.throws(() => fn("dup", async () => 2), /defined twice/);
});

test("values cross the boundary as tagged JSON", () => {
  const sent = encode({ at: new Date("2026-01-02T03:04:05Z"), bytes: new Uint8Array([1, 2]), tags: new Set(["a"]), none: undefined });
  assert.deepEqual(sent, { at: { $dt: "2026-01-02T03:04:05.000Z" }, bytes: { $b64: "AQI=" }, tags: { $set: ["a"] }, none: null });
  const back = decode(sent) as Record<string, unknown>;
  assert.equal(back["at"], "2026-01-02T03:04:05.000Z");
  assert.deepEqual([...(back["bytes"] as Uint8Array)], [1, 2]);
  assert.deepEqual(back["tags"], ["a"]);
});

test("call runs a handler against a fake runtime and records what leaves the function", async () => {
  const runtime = new FakeRuntime({ resources: { stock: [{ id: 1, sku: "A", on_hand: 3 }] }, secrets: { KEY: "k" } });
  fn("stock.reserve", { policy: "authenticated" }, async (ctx) => {
    const row = (await ctx.runtime.resourceGet("stock", 1)) as { on_hand: number };
    if (row.on_hand < ctx.input.n) throw new FunctionError("not enough stock", { status: 409, code: "insufficient_stock" });
    await ctx.runtime.resourceUpdate("stock", 1, { on_hand: row.on_hand - ctx.input.n });
    await ctx.runtime.emit("stock.reserved", ctx.input);
    ctx.log("reserved", ctx.input.n, await ctx.runtime.secret("KEY"));
    return { left: row.on_hand - ctx.input.n };
  });
  const ok = await call("stock.reserve", { sku: "A", n: 2 }, { runtime, auth: user("u1") });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.result, { left: 1 });
  assert.deepEqual(runtime.emitted, [["stock.reserved", { sku: "A", n: 2 }]]);
  assert.deepEqual(ok.logs, [["reserved", 2, "k"]]);
  const refused = await call("stock.reserve", { sku: "A", n: 5 }, { runtime });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.error, { status: 409, code: "insufficient_stock", message: "not enough stock", details: null });
});

test("an unexpected exception is a 500 function_error, as the platform reports it", async () => {
  fn("boom", async () => {
    throw new Error("kaput");
  });
  const result = await call("boom");
  assert.equal(result.error?.status, 500);
  assert.equal(result.error?.code, "function_error");
  assert.equal(result.error?.message, "kaput");
});

test("FakeRuntime says what it cannot answer instead of guessing", async () => {
  const runtime = new FakeRuntime();
  await assert.rejects(runtime.dbQuery("select 1"), /no SQL engine/);
  await assert.rejects(runtime.httpRequest("GET", "https://x.test/a"), /no answer for GET https:\/\/x\.test\/a/);
  await assert.rejects(runtime.callFlow("nope"), /no flow nope is stubbed/);
  await assert.rejects(new Runtime().call("secret", ["A"]), /no connection/);
  const stubbed = new FakeRuntime({ http: { "GET https://x.test/a": { status: 200 } }, sql: () => [{ n: 1 }] });
  assert.deepEqual(await stubbed.httpRequest("get", "https://x.test/a"), { status: 200 });
  assert.deepEqual(await stubbed.dbQuery("select 1"), [{ n: 1 }]);
});

test("a function can call another registered function through the runtime", async () => {
  fn("inner", async (ctx) => ({ twice: ctx.input.n * 2 }));
  fn("outer", async (ctx) => ctx.runtime.callFunction("inner", { n: 4 }));
  assert.deepEqual((await call("outer")).result, { twice: 8 });
});
