#!/usr/bin/env node
import { execSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cliJsPath = path.join(packageRoot, "dist", "cli.js");

execSync("pnpm exec tsc --project tsconfig.build.json", {
  cwd: packageRoot,
  stdio: "inherit",
});

if (!existsSync(cliJsPath)) {
  process.stderr.write(`build failed: expected ${cliJsPath} to exist\n`);
  process.exit(1);
}

// Ensure shebang + executable bit so `pnpm dlx`/`pi-gateway` works.
const existing = readFileSync(cliJsPath, "utf8");
const shebang = "#!/usr/bin/env node\n";
if (!existing.startsWith(shebang)) {
  writeFileSync(cliJsPath, shebang + existing);
}
chmodSync(cliJsPath, 0o755);

process.stdout.write(`build ok: ${cliJsPath}\n`);
