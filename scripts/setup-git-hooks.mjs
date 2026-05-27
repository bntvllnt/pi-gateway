#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

function isGitRepository() {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!isGitRepository()) {
  process.stdout.write(
    "Skipping git hook installation: not inside a git repository.\n",
  );
  process.exit(0);
}

execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
  stdio: "inherit",
});
process.stdout.write("Configured git hooks path: .githooks\n");
