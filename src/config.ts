/**
 * Where the CLI finds its settings, strongest first: flags, `PAWABASE_*` environment variables, `.env`, `pawabase.toml`
 * (found in the project folder or above). A key is never written to `pawabase.toml`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Settings {
  url: string;
  apiKey: string;
  environment: string;
  branch: string;
  functions: string;
  root: string;
  /** Where each setting came from, for `whoami`. */
  sources: Record<string, string>;
}

export class SettingsError extends Error {}

const ENV_NAMES = { url: "PAWABASE_URL", apiKey: "PAWABASE_API_KEY", environment: "PAWABASE_ENVIRONMENT", branch: "PAWABASE_BRANCH" } as const;
const BRANCH = /^[a-z][a-z0-9_-]{0,62}$/;

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[match[1]!] = value;
  }
  return out;
}

/** The flat `key = "value"` subset of TOML that `pawabase.toml` uses. */
export function parseToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*(#.*)?$/);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

export function findProjectFile(start: string): string | null {
  let at = resolve(start);
  for (;;) {
    const candidate = join(at, "pawabase.toml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

export interface Overrides {
  url?: string | undefined;
  apiKey?: string | undefined;
  environment?: string | undefined;
  branch?: string | undefined;
  functions?: string | undefined;
}

export function load(cwd: string, overrides: Overrides = {}, env: NodeJS.ProcessEnv = process.env): Settings {
  const sources: Record<string, string> = {};
  const values: Record<string, string> = {};
  const set = (name: string, value: string | undefined, source: string) => {
    if (value !== undefined && value !== "" && values[name] === undefined) {
      values[name] = value;
      sources[name] = source;
    }
  };
  for (const name of ["url", "apiKey", "environment", "branch", "functions"] as const) set(name, overrides[name], "flag");
  for (const [name, variable] of Object.entries(ENV_NAMES)) set(name, env[variable], "environment");
  const projectFile = findProjectFile(cwd);
  const root = projectFile ? dirname(projectFile) : resolve(cwd);
  const dotenv = join(root, ".env");
  if (existsSync(dotenv)) {
    const file = parseDotenv(readFileSync(dotenv, "utf8"));
    for (const [name, variable] of Object.entries(ENV_NAMES)) set(name, file[variable], ".env");
  }
  if (projectFile) {
    const file = parseToml(readFileSync(projectFile, "utf8"));
    for (const name of ["url", "environment", "branch", "functions"]) set(name, file[name], "pawabase.toml");
  }
  const branch = values["branch"] ?? "main";
  if (!BRANCH.test(branch)) throw new SettingsError(`"${branch}" is not a branch name: lowercase letters, digits, - and _, starting with a letter.`);
  return {
    url: (values["url"] ?? "").replace(/\/+$/, ""),
    apiKey: values["apiKey"] ?? "",
    environment: values["environment"] ?? "development",
    branch,
    functions: values["functions"] ?? "functions",
    root,
    sources,
  };
}

/** Throw a message that says what to set when a needed setting is missing. */
export function require(settings: Settings, ...names: Array<"url" | "apiKey">): void {
  const hints = { url: "PAWABASE_URL (the gateway's address)", apiKey: "PAWABASE_API_KEY (a secret key, pb_sk_…)" } as const;
  const missing = names.filter((name) => !settings[name]);
  if (missing.length) {
    throw new SettingsError(`Missing ${missing.map((name) => hints[name]).join(" and ")}. Set them in the environment, in .env, or with --url / --api-key.`);
  }
}

/** The key with all but its first characters hidden: safe for a log. */
export function redact(key: string): string {
  return key ? `${key.slice(0, 8)}…` : "(not set)";
}
