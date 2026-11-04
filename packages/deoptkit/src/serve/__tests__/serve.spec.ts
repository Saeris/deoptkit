import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { driveServer } from "../index";

describe("driveServer", () => {
  // The one-process SSR observation pattern: boot, warm up outside the window,
  // measure inside it, close cleanly even with keep-alive fetch sockets.
  it("drives a node server through warmup and observed requests, then closes it", async () => {
    let served = 0;
    const server = createServer((request, response) => {
      served += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url }));
    });

    const result = await driveServer({
      start: () => server,
      requests: ["/a", "/b"],
      warmups: 10,
      iterations: 40,
      label: "ssr home"
    });

    expect(result.requests).toBe(40);
    expect(result.failed).toBe(0);
    expect(result.startMark).toBe("ssr_home_start");
    expect(result.endMark).toBe("ssr_home_end");
    expect(served).toBe(50);
    expect(server.listening).toBe(false);
  }, 30_000);

  it("counts error responses instead of throwing mid-measurement", async () => {
    const server = createServer((request, response) => {
      response.statusCode = request.url === "/bad" ? 500 : 200;
      response.end("x");
    });
    const result = await driveServer({
      start: () => server,
      requests: (index) => (index % 2 === 0 ? "/ok" : "/bad"),
      warmups: 2,
      iterations: 10
    });
    expect(result.failed).toBe(5);
    expect(server.listening).toBe(false);
  }, 30_000);

  it("fails loudly when the server never answers the warmups", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await expect(
      driveServer({
        start: () => server,
        requests: ["/missing"],
        warmups: 5,
        iterations: 5
      })
    ).rejects.toThrow(/warmup requests failed/u);
    expect(server.listening).toBe(false);
  }, 30_000);
});
