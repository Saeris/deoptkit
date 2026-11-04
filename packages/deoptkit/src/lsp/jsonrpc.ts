import type { Readable, Writable } from "node:stream";

/**
 * Minimal JSON-RPC 2.0 connection with LSP's Content-Length framing. The surface
 * deliberately mirrors vscode-languageserver's connection (onRequest/onNotification/
 * sendNotification/listen) so swapping to the full library later is mechanical.
 */

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export type RequestHandler = (params: unknown) => unknown;
export type NotificationHandler = (params: unknown) => void | Promise<void>;

/** Any JSON object is a candidate message; dispatch tolerates absent fields. */
const isRpcMessage = (value: unknown): value is RpcMessage =>
  typeof value === "object" && value !== null;

/** Encode one message with LSP framing. */
export const frame = (message: object): Buffer => {
  const body = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", ...message }),
    "utf8"
  );
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body
  ]);
};

/** Incremental parser for framed messages; feed chunks, get complete messages. */
export class FrameParser {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): RpcMessage[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: RpcMessage[] = [];
    for (;;) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headers = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(?<length>\d+)/iu.exec(headers);
      const length = Number(match?.groups?.["length"] ?? Number.NaN);
      if (Number.isNaN(length)) {
        // Unrecoverable framing state; drop the malformed header block.
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + length) break;
      const body = this.#buffer
        .subarray(bodyStart, bodyStart + length)
        .toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      try {
        const parsed: unknown = JSON.parse(body);
        if (isRpcMessage(parsed)) messages.push(parsed);
      } catch {
        // Skip unparseable bodies; the stream stays aligned via Content-Length.
      }
    }
    return messages;
  }
}

export class Connection {
  #requests = new Map<string, RequestHandler>();
  #notifications = new Map<string, NotificationHandler>();
  #parser = new FrameParser();
  #input: Readable;
  #output: Writable;

  constructor(input: Readable, output: Writable) {
    this.#input = input;
    this.#output = output;
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.#requests.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.#notifications.set(method, handler);
  }

  sendNotification(method: string, params: unknown): void {
    this.#output.write(frame({ method, params }));
  }

  #respond(
    id: number | string | null,
    body: Pick<RpcMessage, "result" | "error">
  ): void {
    this.#output.write(frame({ id, ...body }));
  }

  async #dispatch(message: RpcMessage): Promise<void> {
    if (message.method === undefined) return; // responses to server->client requests: none sent
    if (message.id === undefined) {
      await this.#notifications.get(message.method)?.(message.params);
      return;
    }
    const handler = this.#requests.get(message.method);
    if (!handler) {
      this.#respond(message.id, {
        error: {
          code: METHOD_NOT_FOUND,
          message: `Unhandled method: ${message.method}`
        }
      });
      return;
    }
    try {
      this.#respond(message.id, {
        result: (await handler(message.params)) ?? null
      });
    } catch (error) {
      this.#respond(message.id, {
        error: {
          code: INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  listen(): void {
    this.#input.on("data", (chunk: Buffer) => {
      for (const message of this.#parser.push(chunk)) {
        void this.#dispatch(message);
      }
    });
  }
}
