// Test double for tool registration — no transport, no network.
//
// Captures the (name, config, callback) tuples passed to registerTool so the
// enforcement tests can walk every tool's annotations and names, and so handler
// tests can invoke a callback directly with a stubbed client.
//
// Generalized from servarr-mcp, the only repo in the fleet that had this.

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type CapturedTool = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  };
  callback: (...args: unknown[]) => unknown;
};

export class CaptureServer {
  tools: CapturedTool[] = [];

  registerTool(
    name: string,
    config: CapturedTool["config"],
    callback: CapturedTool["callback"],
  ) {
    this.tools.push({ name, config, callback });
    return { name } as unknown;
  }

  byName(name: string): CapturedTool {
    const t = this.tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  }
}

/**
 * Minimal RequestHandlerExtra-shaped object for invoking a handler outside a
 * real MCP request.
 */
export function fakeExtra(progressToken?: string | number) {
  return {
    _meta: progressToken !== undefined ? { progressToken } : undefined,
    sendNotification: async () => undefined,
    sendRequest: async () => undefined,
    signal: new AbortController().signal,
    requestId: "test-req",
  } as unknown as never;
}
