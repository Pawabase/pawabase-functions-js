/**
 * Pack a project's `functions/` folder into the reproducible `.tar.gz` a deployment takes: the same files give the same bytes, so an
 * unchanged project is recognised as "no changes". Nothing here runs your code; credentials are refused before anything leaves the machine.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const SOURCE_SUFFIXES = [".ts", ".mts", ".js", ".mjs"];
/** Never part of a bundle. */
const ALWAYS_EXCLUDED = [".*", "node_modules", "dist", "build", "__pycache__", "*.pyc"];
/** A deployed function does not need its own tests. */
const DEFAULT_EXCLUDED = ["tests", "test", "*.test.ts", "*.test.js", "*.spec.ts", "*.spec.js", "package-lock.json", "deno.lock"];
const SECRET_FILES = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "credentials.json", "*.keystore"];
const TEXT_SUFFIXES = [...SOURCE_SUFFIXES, ".json", ".toml", ".yaml", ".yml", ".txt", ".md", ".html", ".sql"];
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bpb_sk_[A-Za-z0-9_-]{20,}/, "a Pawabase secret key"],
  [/\bsk_live_[A-Za-z0-9]{16,}/, "a live payment secret key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, "a private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bghp_[A-Za-z0-9]{30,}/, "a GitHub token"],
];

export class BundleError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}\n  - ${problems.join("\n  - ")}` : message);
    this.name = "BundleError";
  }
}

export interface Bundle {
  archive: Buffer;
  checksum: string;
  files: Array<{ path: string; size: number }>;
  skipped: string[];
  totalBytes: number;
  /** The archive as base64, which is how a deployment takes it. */
  encoded: string;
}

function glob(pattern: string): RegExp {
  return new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

function matches(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => glob(pattern).test(name));
}

function isSecretFile(name: string): boolean {
  return matches(name, SECRET_FILES) && !/\.(example|sample|template)$/.test(name);
}

interface Entry {
  path: string;
  real: string;
  size: number;
  mode: number;
}

function walk(directory: string, prefix: string, extraExclude: string[], skipped: string[], explicit: boolean, into: Entry[]): void {
  for (const name of readdirSync(directory).sort()) {
    const real = join(directory, name);
    const archivePath = `${prefix}${name}`;
    const info = lstatSync(real);
    if (matches(name, ALWAYS_EXCLUDED) && !isSecretFile(name)) {
      if (info.isFile()) skipped.push(`${archivePath} (hidden file)`);
      continue;
    }
    if (!explicit && matches(name, DEFAULT_EXCLUDED)) {
      if (info.isFile()) skipped.push(`${archivePath} (test file)`);
      continue;
    }
    if (matches(name, extraExclude) || matches(archivePath, extraExclude)) {
      if (info.isFile()) skipped.push(`${archivePath} (excluded)`);
      continue;
    }
    if (info.isSymbolicLink()) {
      skipped.push(`${archivePath} (symbolic link)`);
      continue;
    }
    if (info.isDirectory()) walk(real, `${archivePath}/`, extraExclude, skipped, explicit, into);
    else if (info.isFile()) into.push({ path: archivePath, real, size: info.size, mode: info.mode & 0o111 ? 0o755 : 0o644 });
  }
}

/** Entry files of an HTTP function folder (`functions/<name>/index.ts`), in the order the platform looks for them. */
export const HTTP_ENTRIES = ["index.ts", "index.mts", "index.js", "index.mjs"];
/** Folder names the platform reserves under `/functions/v1/`. */
export const RESERVED = new Set(["public", "v1", "health", "status"]);
const HTTP_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** The HTTP functions of a project: each `functions/<name>/` with an entry file (folders starting with `_` are shared code). */
export function httpFunctions(functionsDir: string): Array<{ name: string; entry: string }> {
  const found: Array<{ name: string; entry: string }> = [];
  for (const name of readdirSync(functionsDir).sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const folder = join(functionsDir, name);
    if (!statSync(folder).isDirectory()) continue;
    const entry = HTTP_ENTRIES.find((file) => {
      try {
        return statSync(join(folder, file)).isFile();
      } catch {
        return false;
      }
    });
    if (entry) found.push({ name, entry: `functions/${name}/${entry}` });
  }
  return found;
}

/** What the functions folder holds: `typescript`, `python`, `mixed`, or `null` when it holds neither. */
export function languageOf(functionsDir: string): "typescript" | "python" | "mixed" | null {
  const names = readdirSync(functionsDir).filter((name) => statSync(join(functionsDir, name)).isFile());
  const python = names.some((name) => name.endsWith(".py"));
  const typescript =
    names.some((name) => SOURCE_SUFFIXES.some((suffix) => name.endsWith(suffix)) && !name.endsWith(".d.ts") && !/\.(test|spec)\./.test(name)) ||
    httpFunctions(functionsDir).length > 0;
  if (python && typescript) return "mixed";
  return typescript ? "typescript" : python ? "python" : null;
}

/** Problems with HTTP function folder names, found before anything is uploaded. */
export function nameProblems(functionsDir: string): string[] {
  const problems: string[] = [];
  for (const { name, entry } of httpFunctions(functionsDir)) {
    if (!HTTP_NAME.test(name)) problems.push(`${entry}: an HTTP function's folder name is lowercase letters, digits, - and _ (at most 63).`);
    if (RESERVED.has(name)) problems.push(`${entry}: "${name}" is reserved by the platform; rename the folder.`);
  }
  return problems;
}

function scan(entries: Entry[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    const name = basename(entry.real);
    if (isSecretFile(name)) {
      problems.push(`${entry.path} looks like a credential file. Keep it out of the bundle (functions read secrets with \`await ctx.runtime.secret(name)\`).`);
      continue;
    }
    if (!TEXT_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    const lines = readFileSync(entry.real, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [pattern, what] of SECRET_PATTERNS) {
        if (pattern.test(line)) problems.push(`${entry.path}:${index + 1} contains ${what}. Move it to a secret (\`pawabase-functions secrets\` or Studio) or pass --allow-secrets if this is a test fixture.`);
      }
    });
  }
  return problems;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** One ustar header + padded content. Deterministic: no owners, no times. */
function tarEntry(path: string, data: Buffer, mode: number): Buffer {
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155 + 1);
    if (cut < 0 || Buffer.byteLength(name.slice(cut + 1)) > 100 || Buffer.byteLength(name.slice(0, cut)) > 155) {
      throw new BundleError(`${path} is too long to archive`, ["Shorten the path (100 characters for the file name, 155 for its folders)."]);
    }
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(octal(mode, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(data.length, 12), 124, "ascii");
  header.write(octal(0, 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write(prefix, 345, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

export interface BuildOptions {
  /** The project folder. */
  root: string;
  /** The folder of functions, relative to `root`. Default `functions`. */
  functions?: string;
  /** More folders to ship beside `functions/` (shared code), each placed at its own name. */
  include?: string[];
  exclude?: string[];
  allowSecrets?: boolean;
}

export function build(options: BuildOptions): Bundle {
  const root = resolve(options.root);
  const functions = options.functions ?? "functions";
  const functionsDir = resolve(root, functions);
  let language: ReturnType<typeof languageOf>;
  try {
    language = languageOf(functionsDir);
  } catch {
    throw new BundleError(`There is no ${functions}/ folder in ${root}. Run \`pawabase-functions init\` to create one.`);
  }
  if (language === "python") throw new BundleError("These are Python functions: deploy them with the `pawabase` command from the Python package.");
  if (language === "mixed") throw new BundleError("A project's functions are one language.", [`${functions}/ holds both Python and TypeScript files: deploy one or the other.`]);
  if (language === null) {
    throw new BundleError(`${functionsDir} contains no functions: add functions/<name>/index.ts (an HTTP function) or functions/*.ts (fn() functions).`);
  }

  const skipped: string[] = [];
  const entries: Entry[] = [];
  walk(functionsDir, "functions/", options.exclude ?? [], skipped, false, entries);
  const taken = new Set(["functions"]);
  for (const item of options.include ?? []) {
    const source = resolve(root, item);
    let info;
    try {
      info = statSync(source);
    } catch {
      throw new BundleError(`include ${JSON.stringify(item)} does not exist (looked for ${source}).`);
    }
    const name = basename(source);
    if (taken.has(name)) throw new BundleError(`include ${JSON.stringify(item)} would be placed at ${name}/, which is already taken.`);
    taken.add(name);
    if (info.isDirectory()) walk(source, `${name}/`, options.exclude ?? [], skipped, true, entries);
    else entries.push({ path: name, real: source, size: info.size, mode: info.mode & 0o111 ? 0o755 : 0o644 });
  }

  const problems = [...nameProblems(functionsDir), ...(options.allowSecrets ? [] : scan(entries))];
  if (entries.length > MAX_FILES) problems.push(`The bundle would contain ${entries.length} files; the limit is ${MAX_FILES}. Exclude what the functions do not import.`);
  for (const entry of entries) {
    if (entry.size > MAX_FILE_BYTES) problems.push(`${entry.path} is ${Math.floor(entry.size / 1024 / 1024)}MB; the limit per file is ${MAX_FILE_BYTES / 1024 / 1024}MB.`);
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) problems.push(`The bundle is larger than ${MAX_TOTAL_BYTES / 1024 / 1024}MB unpacked.`);
  if (problems.length) throw new BundleError("The bundle cannot be built:", problems);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const tar = Buffer.concat([...entries.map((entry) => tarEntry(entry.path.split(sep).join("/"), readFileSync(entry.real), entry.mode)), Buffer.alloc(1024)]);
  const archive = gzipSync(tar, { level: 9 });
  archive[4] = archive[5] = archive[6] = archive[7] = 0; // no modification time
  archive[9] = 3; // the same "Unix" marker on every machine
  return {
    archive,
    checksum: createHash("sha256").update(archive).digest("hex"),
    files: entries.map((entry) => ({ path: entry.path, size: entry.size })),
    skipped: skipped.sort(),
    totalBytes,
    encoded: archive.toString("base64"),
  };
}

/** The files inside a bundle, for inspection and tests. */
export function read(archive: Buffer): Record<string, Buffer> {
  const tar = gunzipSync(archive);
  const out: Record<string, Buffer> = {};
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    out[prefix ? `${prefix}/${name}` : name] = Buffer.from(tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

