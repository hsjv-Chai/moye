import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { requestFor, streamAI } from "../electron/ai";
import type { Connection } from "../shared/model";
let server: http.Server, baseUrl: string;
let requests: any[] = [];
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, headers: req.headers, body });
    if (body.model === "unauthorized") {
      res.writeHead(401);
      res.end("sensitive-detail");
      return;
    }
    if (body.model === "timeout") return;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.model === "broken") {
      res.end('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
      return;
    }
    if (body.model === "error") {
      res.end('data: {"error":{"message":"secret detail"}}\n\n');
      return;
    }
    if (req.url?.endsWith("/messages")) {
      res.write(
        'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\r\n\r\n',
      );
      res.end('data: {"type":"message_stop"}\n\n');
      return;
    }
    if (body.model === "slow") {
      res.write('data: {"choices":[{"delta":{"content":"保留"}}]}\n\n');
      const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 3000);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    const bytes = Buffer.from(
      'data: {"choices":[{"delta":{"content":"中文"}}]}\n\ndata: {"choices":[{"delta":{"content":"测试"}}]}\n\ndata: [DONE]\n\n',
    );
    for (let i = 0; i < bytes.length; i += 3)
      res.write(bytes.subarray(i, i + 3));
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
const c = (): Connection => ({
  id: "c",
  provider: "custom",
  name: "测试",
  baseUrl,
  model: "mock",
  temperature: null,
  outputTokens: 512,
  contextTokens: 8000,
  tokenParam: "max_tokens",
});
describe("provider adapters", () => {
  it("parses fragmented UTF-8 SSE for every compatible provider", async () => {
    for (const provider of [
      "openai",
      "deepseek",
      "glm",
      "kimi",
      "custom",
    ] as const) {
      let text = "";
      await streamAI(
        { ...c(), provider },
        "key",
        "写小说",
        new AbortController().signal,
        (s) => (text += s),
      );
      expect(text).toBe("中文测试");
      expect(requests.at(-1).headers.authorization).toBe("Bearer key");
      expect(requests.at(-1).url).toBe("/v1/chat/completions");
    }
  });
  it("uses Claude messages, its auth headers and text deltas", async () => {
    let text = "";
    await streamAI(
      { ...c(), provider: "claude" },
      "claude-key",
      "写作",
      new AbortController().signal,
      (s) => (text += s),
    );
    expect(text).toBe("你好");
    const req = requests.at(-1);
    expect(req.headers["x-api-key"]).toBe("claude-key");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.body.max_tokens).toBe(512);
    expect(req.headers.authorization).toBeUndefined();
  });
  it("supports configurable output parameters and omitted temperature", () => {
    expect(
      requestFor({ ...c(), tokenParam: "omit" }, "", "prompt").body,
    ).not.toHaveProperty("max_tokens");
    const body = requestFor(
      { ...c(), tokenParam: "max_completion_tokens", temperature: 0.5 },
      "",
      "prompt",
    ).body;
    expect(body.max_completion_tokens).toBe(512);
    expect(body.temperature).toBe(0.5);
    expect(requestFor(c(), "", "prompt").body).not.toHaveProperty(
      "temperature",
    );
  });
  it("keeps output received before cancellation", async () => {
    const controller = new AbortController();
    let text = "";
    await streamAI(
      { ...c(), model: "slow" },
      "",
      "写作",
      controller.signal,
      (s) => {
        text += s;
        controller.abort();
      },
    );
    expect(text).toBe("保留");
  });
  it("reports useful errors without leaking response secrets", async () => {
    await expect(
      streamAI(
        { ...c(), model: "unauthorized" },
        "",
        "x",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("鉴权失败");
    await expect(
      streamAI(
        { ...c(), model: "error" },
        "",
        "x",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("模型服务");
  });
  it("detects an interrupted stream and retains partial output", async () => {
    let text = "";
    await expect(
      streamAI(
        { ...c(), model: "broken" },
        "",
        "x",
        new AbortController().signal,
        (s) => (text += s),
      ),
    ).rejects.toThrow("提前中断");
    expect(text).toBe("部分");
  });
  it("times out a nonresponsive service", async () => {
    await expect(
      streamAI(
        { ...c(), model: "timeout" },
        "",
        "x",
        new AbortController().signal,
        () => {},
        30,
      ),
    ).rejects.toThrow("超时");
  });
  it("rejects oversized context and unsafe remote HTTP", () => {
    expect(() =>
      requestFor({ ...c(), contextTokens: 1000 }, "", "字".repeat(1000)),
    ).toThrow("超过预算");
    expect(() =>
      requestFor({ ...c(), baseUrl: "http://remote.example/v1" }, "", "x"),
    ).toThrow("HTTPS");
  });
});
