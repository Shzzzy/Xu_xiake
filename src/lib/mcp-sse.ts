export type McpMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export function parseMcpSse(text: string): McpMessage[] {
  const messages: McpMessage[] = [];

  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data) as McpMessage;
      if (parsed && typeof parsed === "object") messages.push(parsed);
    } catch {
      // Ignore non-JSON event payloads; MCP result frames are JSON.
    }
  }

  return messages;
}
