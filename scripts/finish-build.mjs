// The CLI is run directly by name, so it needs a shebang and the executable bit.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const cli = "dist/cli.js";
const source = readFileSync(cli, "utf8");
if (!source.startsWith("#!")) writeFileSync(cli, `#!/usr/bin/env node\n${source}`);
chmodSync(cli, 0o755);
