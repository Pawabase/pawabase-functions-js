import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BundleError, build, read } from "../src/bundle.js";

const made: string[] = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pbfn-"));
  made.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const HELLO = 'import { fn } from "@pawabase/functions";\nexport const hello = fn("hello", async () => 1);\n';

test("a bundle holds the functions and leaves out tests, hidden files and node_modules", () => {
  const root = project({ "functions/hello.ts": HELLO, "functions/hello.test.ts": "x", "functions/.cache": "x", "functions/lib/util.ts": "export {};\n", "node_modules/a/b.js": "x" });
  const packed = build({ root });
  assert.deepEqual(packed.files.map((f) => f.path), ["functions/hello.ts", "functions/lib/util.ts"]);
  assert.ok(packed.skipped.some((s) => s.startsWith("functions/hello.test.ts")));
  assert.equal(read(packed.archive)["functions/hello.ts"]!.toString(), HELLO);
  assert.equal(Buffer.from(packed.encoded, "base64").equals(packed.archive), true);
});

test("the same files make the same bytes, a changed file makes different ones", () => {
  const root = project({ "functions/hello.ts": HELLO });
  const first = build({ root });
  assert.equal(build({ root }).checksum, first.checksum);
  writeFileSync(join(root, "functions/hello.ts"), HELLO + "// changed\n");
  assert.notEqual(build({ root }).checksum, first.checksum);
});

test("credentials in source or as files stop the bundle before anything is uploaded", () => {
  const leak = project({ "functions/hello.ts": `const KEY = "pb_sk_abcdefghijklmnopqrstuvwxyz";\n` });
  assert.throws(() => build({ root: leak }), (error: unknown) => error instanceof BundleError && error.problems[0]!.startsWith("functions/hello.ts:1 contains a Pawabase secret key"));
  assert.doesNotThrow(() => build({ root: leak, allowSecrets: true }));
  const file = project({ "functions/hello.ts": HELLO, "functions/.env": "A=1\n" });
  assert.throws(() => build({ root: file }), /looks like a credential file/);
});

test("a project is one language, and there must be something to deploy", () => {
  assert.throws(() => build({ root: project({ "functions/a.ts": HELLO, "functions/b.py": "x" }) }), /one language/);
  assert.throws(() => build({ root: project({ "functions/b.py": "x" }) }), /Python/);
  assert.throws(() => build({ root: project({ "functions/readme.md": "x" }) }), /contains no functions/);
  assert.throws(() => build({ root: project({}) }), /no functions\/ folder/);
});

test("include ships shared code beside functions/, and refuses a name that is taken", () => {
  const root = project({ "functions/hello.ts": HELLO, "shared/money.ts": "export const x = 1;\n" });
  assert.ok(build({ root, include: ["shared"] }).files.some((f) => f.path === "shared/money.ts"));
  assert.throws(() => build({ root, include: ["functions"] }), /already taken/);
  assert.throws(() => build({ root, include: ["nope"] }), /does not exist/);
});

test("long paths are archived with a ustar prefix and read back whole", () => {
  const deep = "functions/" + "d".repeat(60) + "/" + "e".repeat(60) + "/handler.ts";
  const packed = build({ root: project({ "functions/hello.ts": HELLO, [deep]: "export {};\n" }) });
  assert.ok(deep in read(packed.archive));
});
