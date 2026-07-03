import type { Server } from "node:http";
import { mark } from "../harness/index";

/** Whatever `start()` returns: a node http.Server, a port, or a base URL. */
export type ServerHandle =
  | Server
  | { port: number; close?: () => unknown }
  | { url: string; close?: () => unknown };

export interface DriveServerOptions {
  /** Boot the app and return its server/port/url. Called once. */
  start: () => ServerHandle | Promise<ServerHandle>;
  /** Request paths to cycle through, or a function of the request index. */
  requests: string[] | ((index: number) => string);
  /** Requests inside the observed window (default 2000 — enough for tier-up). */
  iterations?: number;
  /** Requests fired before the start marker, so boot/first-hit noise stays outside. */
  warmups?: number;
  /** Marker label; the observed window is `<label>_start`..`<label>_end`. */
  label?: string;
}

export interface DriveServerResult {
  label: string;
  startMark: string;
  endMark: string;
  requests: number;
  /** Non-2xx/3xx responses and rejected fetches; high counts mean you measured errors. */
  failed: number;
}

const isNodeServer = (handle: ServerHandle): handle is Server =>
  "listen" in handle && typeof handle.listen === "function";

const baseUrlOf = async (handle: ServerHandle): Promise<string> => {
  if (isNodeServer(handle)) {
    if (!handle.listening) {
      await new Promise<void>((resolve) => handle.listen(0, resolve));
    }
    const address = handle.address();
    if (address === null || typeof address === "string") {
      throw new Error("deoptkit/serve: cannot determine the server's port");
    }
    return `http://127.0.0.1:${address.port}`;
  }
  if ("url" in handle) return handle.url.replace(/\/$/u, "");
  return `http://127.0.0.1:${handle.port}`;
};

const closeHandle = async (handle: ServerHandle): Promise<void> => {
  if (isNodeServer(handle)) {
    // Keep-alive fetch sockets would otherwise hold close() open indefinitely.
    handle.closeAllConnections();
    await new Promise<void>((resolve) => handle.close(() => resolve()));
    return;
  }
  await handle.close?.();
};

/**
 * Boot an app's HTTP server in-process and drive it with repeated requests inside a
 * marked observation window — the one-process pattern that makes SSR runtimes
 * observable (V8 logging flags do not cross child-process boundaries). Requests run
 * sequentially so log attribution stays clean.
 */
export const driveServer = async (
  options: DriveServerOptions
): Promise<DriveServerResult> => {
  const iterations = options.iterations ?? 2000;
  const warmups = options.warmups ?? 200;
  const label = options.label ?? "serve";
  const requests = options.requests;
  const pathFor =
    typeof requests === "function"
      ? requests
      : (index: number): string => requests[index % requests.length] ?? "/";

  const handle = await options.start();
  const base = await baseUrlOf(handle);
  let failed = 0;
  const hit = async (index: number): Promise<void> => {
    try {
      const response = await fetch(`${base}${pathFor(index)}`);
      if (response.status >= 400) failed += 1;
      // Drain so keep-alive sockets recycle and body work is attributed to the window.
      await response.arrayBuffer();
    } catch {
      failed += 1;
    }
  };

  try {
    for (let index = 0; index < warmups; index++) await hit(index);
    if (failed >= warmups && warmups > 0) {
      throw new Error(
        `deoptkit/serve: all ${warmups} warmup requests failed against ${base} — is the server routing these paths?`
      );
    }
    failed = 0;
    const startMark = mark(`${label}_start`);
    for (let index = 0; index < iterations; index++) await hit(index);
    const endMark = mark(`${label}_end`);
    return { label, startMark, endMark, requests: iterations, failed };
  } finally {
    await closeHandle(handle);
  }
};
