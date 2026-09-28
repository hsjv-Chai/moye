import { type Connection, estimateTokens } from "../shared/model";
export function requestFor(c: Connection, key: string, prompt: string) {
  const url = new URL(c.baseUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "API 地址必须是有效的 HTTP(S) 基础地址，不能包含凭据、查询参数或片段。",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("远程接口请使用 HTTPS；HTTP 仅限本机服务。");
  if (estimateTokens(prompt) + c.outputTokens > c.contextTokens)
    throw new Error("上下文超过预算，请减少勾选资料、正文长度或输出上限。");
  const base = c.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const body: Record<string, unknown> = {
    model: c.model,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  };
  if (c.provider === "claude") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    body.max_tokens = c.outputTokens;
  } else {
    if (key) headers.Authorization = `Bearer ${key}`;
    if (c.tokenParam !== "omit") body[c.tokenParam] = c.outputTokens;
  }
  if (c.temperature !== null) body.temperature = c.temperature;
  return {
    url: `${base}/${c.provider === "claude" ? "messages" : "chat/completions"}`,
    headers,
    body,
  };
}
export async function streamAI(
  c: Connection,
  key: string,
  prompt: string,
  signal: AbortSignal,
  onChunk: (text: string) => void,
  timeoutMs = 90000,
) {
  const req = requestFor(c, key, prompt);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  reset();
  try {
    const response = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: "请求参数不受支持，请检查模型、温度和输出参数。",
        401: "鉴权失败，请检查 API Key。",
        403: "无权访问该模型，请检查服务权限。",
        404: "接口或模型不存在，请检查 API 地址和模型名。",
        429: "服务限流或额度不足，请稍后手动重试。",
      };
      throw new Error(
        messages[response.status] ||
          `服务返回 HTTP ${response.status}，请稍后重试。`,
      );
    }
    if (!response.body) throw new Error("服务未返回响应流。");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      ended = false,
      received = false;
    const consume = (event: string) => {
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      if (data === "[DONE]") {
        ended = true;
        return;
      }
      let value: any;
      try {
        value = JSON.parse(data);
      } catch {
        throw new Error("服务返回了无法解析的流式数据。");
      }
      if (value.error || value.type === "error")
        throw new Error("模型服务在生成过程中返回错误，请检查连接或稍后重试。");
      const chunk =
        c.provider === "claude"
          ? value.type === "content_block_delta" &&
            value.delta?.type === "text_delta"
            ? value.delta.text
            : ""
          : value.choices?.[0]?.delta?.content;
      if (typeof chunk === "string" && chunk) {
        received = true;
        onChunk(chunk);
      }
      if (value.type === "message_stop" || value.choices?.[0]?.finish_reason) {
        ended = true;
        if (value.choices?.[0]?.finish_reason === "length")
          throw new Error("已达到输出上限，部分内容已保留；可采纳后续写。");
      }
      if (
        c.provider === "claude" &&
        value.type === "message_delta" &&
        value.delta?.stop_reason === "max_tokens"
      )
        throw new Error("已达到输出上限，部分内容已保留；可采纳后续写。");
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reset();
        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          consume(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
        }
        if (ended) break;
      }
      buffer += decoder.decode();
      if (buffer.trim() && !ended) consume(buffer);
      if (!ended) throw new Error("连接提前中断，已保留收到的内容。");
      if (!received)
        throw new Error("模型未返回正文，请检查模型能力或输出上限。");
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (signal.aborted) return;
    if (timedOut) throw new Error("服务响应超时，已保留部分内容，可手动重试。");
    if (error instanceof TypeError)
      throw new Error("网络连接失败，请检查网络和 API 地址。");
    throw error;
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", abort);
  }
}
