/**
 * Programmatic API for tests and embedding.
 *
 * Exposes `startServer` / `stopServer` that bind a real HTTP listener without
 * the side-effects of `cli.ts` (no argv parsing, no SIGINT handler, no PID
 * lockfile claim). Tests use this to exercise the wire protocol against a
 * `faux` pi-ai provider on `127.0.0.1:0`.
 */
import type { Server } from "node:http";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { GatewayConfig } from "../config.js";

import { createHttpServer } from "./http-server.js";

export interface StartServerInput {
  config: GatewayConfig;
  log?: (
    level: "debug" | "info" | "warn" | "error",
    payload: Record<string, unknown>,
  ) => void;
  modelRegistry?: ModelRegistry;
}

export interface RunningHandle {
  /** Aborts every in-flight upstream pi-ai stream. */
  abortAllStreams(): void;
  address: { address: string; family: string; port: number };
  /** Closes the listener; existing connections continue until they end. */
  close(): Promise<void>;
  modelCount: number;
  modelRegistry: ModelRegistry;
  server: Server;
}

export async function startServer(
  input: StartServerInput,
): Promise<RunningHandle> {
  const modelRegistry =
    input.modelRegistry ?? buildDefaultRegistry(input.config.authDir);
  const log =
    input.log ??
    ((level, payload) => {
      const line = JSON.stringify({
        level,
        ts: new Date().toISOString(),
        ...payload,
      });

      console.error(line);
    });

  const running = createHttpServer({
    config: input.config,
    log,
    modelRegistry,
  });

  const server = running.server;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.config.port, input.config.bindAddress);
  });

  const rawAddr = server.address();
  if (!rawAddr || typeof rawAddr !== "object") {
    throw new Error("server.address() returned null after listen");
  }
  const address = rawAddr;

  const modelCount = modelRegistry.getAvailable().length;

  return {
    abortAllStreams: running.abortAllStreams,
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    modelCount,
    modelRegistry,
    server,
  };
}

export async function stopServer(handle: RunningHandle): Promise<void> {
  handle.abortAllStreams();
  await handle.close();
}

function buildDefaultRegistry(authDir?: string): ModelRegistry {
  const authStorage = authDir
    ? AuthStorage.create(`${authDir}/auth.json`)
    : AuthStorage.create();
  const modelRegistry = authDir
    ? ModelRegistry.create(authStorage, `${authDir}/models.json`)
    : ModelRegistry.create(authStorage);
  return modelRegistry;
}
