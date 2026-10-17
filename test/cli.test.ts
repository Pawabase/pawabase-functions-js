import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main, type Io } from "../src/cli.js";

const KEY = "pb_sk_cli_test_key_0000000000";
const made: string[] = [];
const servers: Server[] = [];
after(async () => {
  made.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
});

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

async function gateway() {
  const seen: Seen[] = [];
  const state: { active: any; refuse: string[] | null } = { active: null, refuse: null };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://x");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const base = "/platform/v1/envs/development";
    if (url.pathname === `${base}/function-deployments` && req.method === "GET") return send(200, { data: state.active ? [state.active] : [] });
    if (url.pathname === `${base}/function-deployments` && req.method === "POST") {
      if (state.refuse) return send(422, { detail: { message: "The new code does not load, so it was not activated.", problems: state.refuse } });
      const { createHash } = await import("node:crypto");
      state.active = { id: "d".repeat(32), status: "active", branch: body.branch, checksum: createHash("sha256").update(Buffer.from(body.archive, "base64")).digest("hex") };
      return send(201, { deployment: state.active, functions: [{ name: "hello" }] });
    }
    if (url.pathname === `${base}/functions`) return send(200, { data: [{ name: "hello", policy: "public", description: "Say hello" }] });
    if (url.pathname.endsWith("/invoke")) return send(200, { status: "succeeded", result: { ok: true } });
    return send(404, { error: "not_found", message: "not found" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, state };
}

function sandbox(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pbfn-cli-"));
  made.push(root);
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => void out.push(t), err: (t) => void err.push(t), confirm: async () => false, cwd: root, env, interactive: false };
  return { root, io, out, err, text: () => out.join("\n"), errors: () => err.join("\n") };
}

async function configured(env: Record<string, string> = {}) {
  const fake = await gateway();
  const box = sandbox({ PAWABASE_URL: fake.url, PAWABASE_API_KEY: KEY, ...env });
  assert.equal(await main(["init"], box.io), 0);
  return { fake, box };
}

test("init scaffolds a function and a test, and keeps .env out of git", async () => {
  const box = sandbox();
  assert.equal(await main(["init"], box.io), 0);
  assert.ok(existsSync(join(box.root, "functions/hello/index.ts")) && existsSync(join(box.root, "tests/hello.test.ts")) && existsSync(join(box.root, ".env.example")));
  assert.ok(readFileSync(join(box.root, ".gitignore"), "utf8").split("\n").includes(".env"));
  assert.equal(await main(["init"], box.io), 0);
  assert.match(box.text(), /already set up/);
});

test("missing settings exit 2 and say what to set", async () => {
  const box = sandbox();
  await main(["init"], box.io);
  assert.equal(await main(["deploy"], box.io), 2);
  assert.match(box.errors(), /PAWABASE_API_KEY/);
});

test("settings come from flags, the environment, .env and pawabase.toml, strongest first", async () => {
  const box = sandbox({ PAWABASE_ENVIRONMENT: "staging" });
  writeFileSync(join(box.root, "pawabase.toml"), 'url = "https://toml.test"\nenvironment = "toml-env"\n');
  writeFileSync(join(box.root, ".env"), `PAWABASE_API_KEY=${KEY}\nPAWABASE_URL=https://dotenv.test\n`);
  assert.equal(await main(["whoami", "--json", "--url", "https://flag.test"], box.io), 0);
  const info = JSON.parse(box.out[0]!);
  assert.equal(info.url, "https://flag.test");
  assert.equal(info.environment, "staging");
  assert.equal(info.sources.apiKey, ".env");
  assert.ok(!box.text().includes(KEY), "the key must never be printed");
});

test("a dry run builds and checks but uploads nothing", async () => {
  const { fake, box } = await configured();
  assert.equal(await main(["deploy", "--dry-run"], box.io), 0);
  assert.match(box.text(), /Dry run/);
  assert.deepEqual(fake.seen, []);
});

test("deploy uploads once, then says nothing changed; --force deploys again", async () => {
  const { fake, box } = await configured();
  assert.equal(await main(["deploy"], box.io), 0);
  const posts = () => fake.seen.filter((r) => r.method === "POST");
  assert.equal(posts().length, 1);
  assert.equal(posts()[0]!.body.branch, "main");
  assert.ok(posts()[0]!.body.archive.length > 0);
  assert.match(box.text(), /Deployed to development/);
  assert.equal(await main(["deploy"], box.io), 0);
  assert.match(box.text(), /No changes/);
  assert.equal(posts().length, 1);
  assert.equal(await main(["deploy", "--force"], box.io), 0);
  assert.equal(posts().length, 2);
});

test("a branch deploys beside main", async () => {
  const { fake, box } = await configured();
  assert.equal(await main(["deploy", "--branch", "feature-x"], box.io), 0);
  assert.equal(fake.seen.find((r) => r.method === "POST")!.body.branch, "feature-x");
  assert.equal(fake.seen.find((r) => r.method === "GET")!.query.get("branch"), "feature-x");
});

test("credentials in source stop the deploy before the network", async () => {
  const { fake, box } = await configured();
  writeFileSync(join(box.root, "functions/leak.ts"), 'export const k = "pb_sk_abcdefghijklmnopqrstuvwxyz";\n');
  assert.equal(await main(["deploy"], box.io), 1);
  assert.match(box.errors(), /functions\/leak\.ts:1/);
  assert.deepEqual(fake.seen, []);
});

test("a refusal from the deployment lists each problem", async () => {
  const { fake, box } = await configured();
  fake.state.refuse = ["functions/hello.ts: SyntaxError: Unexpected token"];
  assert.equal(await main(["deploy"], box.io), 1);
  assert.match(box.errors(), /was refused/);
  assert.match(box.errors(), /Unexpected token/);
});

test("production needs a yes", async () => {
  const { fake, box } = await configured({ PAWABASE_ENVIRONMENT: "production" });
  assert.equal(await main(["deploy"], box.io), 2);
  assert.match(box.errors(), /--yes/);
  assert.equal(fake.seen.filter((r) => r.method === "POST").length, 0);
});

test("functions lists what is deployed; invoke runs one; bad data is a usage error", async () => {
  const { box } = await configured();
  assert.equal(await main(["functions", "--json"], box.io), 0);
  assert.equal(JSON.parse(box.out.at(-1)!)[0].name, "hello");
  assert.equal(await main(["invoke", "hello", "-d", '{"name":"Ada"}'], box.io), 0);
  assert.equal(JSON.parse(box.out.at(-1)!).result.ok, true);
  assert.equal(await main(["invoke", "hello", "-d", "{nope"], box.io), 2);
  assert.match(box.errors(), /not valid JSON/);
});

test("a mixed or Python project is refused with a reason", async () => {
  const { box } = await configured();
  mkdirSync(join(box.root, "functions"), { recursive: true });
  writeFileSync(join(box.root, "functions/extra.py"), "x");
  assert.equal(await main(["deploy"], box.io), 1);
  assert.match(box.errors(), /one language/);
});

test("new creates an HTTP function folder, or an fn() file with --fn, and refuses reserved names", async () => {
  const box = sandbox();
  assert.equal(await main(["new", "orders"], box.io), 0);
  assert.ok(readFileSync(join(box.root, "functions/orders/index.ts"), "utf8").includes("serve("));
  assert.equal(await main(["new", "orders"], box.io), 2);
  assert.equal(await main(["new", "public"], box.io), 2);
  assert.equal(await main(["new", "Bad Name"], box.io), 2);
  assert.equal(await main(["new", "billing.charge", "--fn"], box.io), 0);
  assert.ok(readFileSync(join(box.root, "functions/billing_charge.ts"), "utf8").includes('fn("billing.charge"'));
});

test("a project of HTTP functions deploys and names them", async () => {
  const { fake, box } = await configured();
  assert.equal(await main(["deploy"], box.io), 0);
  assert.match(box.text(), /http functions: hello/);
  assert.equal(fake.seen.filter((r) => r.method === "POST").length, 1);
});

