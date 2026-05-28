#!/usr/bin/env node
/**
 * Lifecycle invariants: PID locking and signal shutdown ordering.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import createJiti from "@mariozechner/jiti";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function testPidLockfileClaimConflictReleaseAndStaleCleanup() {
  const lifecycle = await jiti(path.join(packageRoot, "src", "lifecycle.ts"));
  const dir = mkdtempSync(path.join(tmpdir(), "pi-gateway-pid-"));
  const pidPath = path.join(dir, "gateway.pid");
  try {
    const claim = lifecycle.claimPidLockfile(pidPath);
    assert.equal(claim.ok, true);
    assert.equal(Number(readFileSync(pidPath, "utf8")), process.pid);

    const conflict = lifecycle.claimPidLockfile(pidPath);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "alive");
    assert.equal(conflict.ownerPid, process.pid);

    lifecycle.releasePidLockfile(pidPath);
    assert.equal(existsSync(pidPath), false);

    writeFileSync(pidPath, "2147483647\n", "utf8");
    const staleClaim = lifecycle.claimPidLockfile(pidPath);
    assert.equal(staleClaim.ok, true);
    assert.equal(Number(readFileSync(pidPath, "utf8")), process.pid);
  } finally {
    lifecycle.releasePidLockfile(pidPath);
    rmSync(dir, { force: true, recursive: true });
  }
  log("PASS PID lockfile claim/conflict/release/stale cleanup");
}

async function testSignalShutdownOrdering() {
  const lifecycle = await jiti(path.join(packageRoot, "src", "lifecycle.ts"));
  const order = [];
  const originalExit = process.exit;
  process.exit = (code) => {
    order.push(`exit:${code}`);
  };
  const remove = lifecycle.installSignalHandlers({
    controller: {
      abortAllStreams: () => order.push("abort"),
      flushSockets: async (timeoutMs) => {
        order.push(`flush:${timeoutMs}`);
      },
    },
    forceAbortTimeoutMs: 123,
    onShuttingDown: () => order.push("notify"),
    serverClose: async () => {
      order.push("close");
    },
  });
  try {
    process.emit("SIGTERM", "SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [
      "notify",
      "abort",
      "flush:123",
      "close",
      "exit:0",
    ]);
  } finally {
    remove();
    process.exit = originalExit;
  }
  log("PASS signal shutdown ordering");
}

async function main() {
  await testPidLockfileClaimConflictReleaseAndStaleCleanup();
  await testSignalShutdownOrdering();
  log("ALL LIFECYCLE TESTS PASSED");
}

main().catch((err) => {
  process.stderr.write(
    `LIFECYCLE TESTS FAILED: ${err && err.stack ? err.stack : err}\n`,
  );
  process.exit(1);
});
