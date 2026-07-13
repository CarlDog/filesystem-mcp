#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import {
  FilesystemClient,
  type FilesystemConfig,
} from "./clients/filesystem.js";
import { parseRoots, deriveRootsFromVolumes, resolveRoots } from "./config.js";
import { registerFilesystemTools } from "./tools/index.js";

const DEFAULT_DENY_PATTERNS = [
  "*.env",
  "*.key",
  "*.pem",
  "*.pfx",
  "*.p12",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "known_hosts",
  "authorized_keys",
  ".htpasswd",
  "*.kdbx",
];

const INSTRUCTIONS = `MCP server exposing scoped filesystem operations. Designed primarily for media library inspection and organization (think: "what orphan files are in /media/Movies that aren't tracked by Radarr?"), but useful for any directory the operator wants to expose.

Idioms:
- All tools take absolute paths. Every path is resolved (including symlinks) and asserted to live under one of the FS_ROOTS configured at startup. Paths outside the roots are refused. Call fs_list_roots first if you don't know what's exposed.
- Sensitive-looking basenames (matching FS_DENY_FILE_PATTERNS — *.env, *.key, id_rsa*, etc.) are silently filtered from list results and refused for direct read/stat. The MCP intentionally won't expose them.
- Reads are bounded: fs_read_file caps at FS_MAX_READ_BYTES (default 1 MiB), fs_list_directory caps at FS_MAX_LIST_ENTRIES (default 1000).
- Mutation tools (fs_move, fs_copy, fs_delete, fs_mkdir) are only registered when FS_ALLOW_WRITE=true. Even then, the standard idiom is to invoke with dry_run=true first and inspect the preview before flipping it off. Confirm with the user before mutating.

Composition: this MCP is most useful paired with a domain MCP that knows what files SHOULD exist (e.g. servarr-mcp's *_list_movies returns paths). The agent reconciles "what's actually on disk" (this MCP) against "what's tracked" (the domain MCP).`;

function parseDenyPatterns(raw: string | undefined): string[] {
  if (raw === undefined) return DEFAULT_DENY_PATTERNS;
  if (raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    // Fail soft: a single malformed value must not crash-loop the
    // server under restart: unless-stopped. Log and use the default.
    console.error(
      `filesystem-mcp: invalid ${name}: "${raw}" — using default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

async function buildConfig(): Promise<FilesystemConfig> {
  // FS_ROOTS is the explicit allowlist. When it's unset, default to the
  // container-side targets of the configured bind mounts (FS_VOLUME*),
  // so the operator declares each mount exactly once and the roots can't
  // drift from what's actually mounted. An explicit FS_ROOTS still wins,
  // which lets it *narrow* the exposed set below the full mount list.
  let declaredRoots = parseRoots(process.env.FS_ROOTS);
  let rootsSource = "FS_ROOTS";
  if (declaredRoots.length === 0) {
    declaredRoots = deriveRootsFromVolumes([
      process.env.FS_VOLUME,
      process.env.FS_VOLUME_2,
      process.env.FS_VOLUME_3,
    ]);
    rootsSource = "FS_VOLUME* (derived)";
  }
  if (declaredRoots.length === 0) {
    console.error(
      "No roots configured: set FS_ROOTS (comma-separated absolute paths) " +
        "or FS_VOLUME* bind specs to derive them from.",
    );
    process.exit(1);
  }

  // Resolve roots through realpath() once at startup. Invalid entries
  // (non-absolute, non-existent, non-directory) are logged and dropped
  // rather than aborting — a single stale entry (e.g. a mount target that
  // didn't get mounted) must not crash-loop the whole server. We only
  // refuse to start if *no* valid root survives.
  const { resolved: resolvedRoots, skipped } =
    await resolveRoots(declaredRoots);
  for (const s of skipped) {
    console.error(
      `filesystem-mcp: skipping invalid root "${s.root}" from ${rootsSource} (${s.reason})`,
    );
  }
  if (resolvedRoots.length === 0) {
    console.error(
      `filesystem-mcp: no valid roots after validation (source: ${rootsSource}); refusing to start.`,
    );
    process.exit(1);
  }

  return {
    roots: resolvedRoots,
    denyPatterns: parseDenyPatterns(process.env.FS_DENY_FILE_PATTERNS),
    allowWrite:
      (process.env.FS_ALLOW_WRITE ?? "false").toLowerCase() === "true",
    maxReadBytes: parseIntEnv(
      process.env.FS_MAX_READ_BYTES,
      1024 * 1024,
      "FS_MAX_READ_BYTES",
    ),
    maxListEntries: parseIntEnv(
      process.env.FS_MAX_LIST_ENTRIES,
      1000,
      "FS_MAX_LIST_ENTRIES",
    ),
    // Hardcoded for now — these are safety thresholds protecting against
    // operations that would exceed transport timeouts. Promote to env
    // vars (FS_MAX_COPY_ENTRIES / FS_MAX_COPY_BYTES) if an operator has
    // a legitimate need to tune them.
    maxCopyEntries: 10_000,
    maxCopyBytes: 500 * 1024 * 1024 * 1024, // 500 GiB
  };
}

const config = await buildConfig();
const fsClient = new FilesystemClient(config);

console.error(
  `filesystem-mcp: roots=${config.roots.join(",")} allow_write=${config.allowWrite} deny_patterns=${config.denyPatterns.length} max_read=${config.maxReadBytes} max_list=${config.maxListEntries}`,
);

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "filesystem-mcp",
      version: "0.1.0",
    },
    {
      instructions: INSTRUCTIONS,
    },
  );
  registerFilesystemTools(server, fsClient, { allowWrite: config.allowWrite });
  return server;
}

const portStr = process.env.MCP_PORT;
let port = portStr ? Number.parseInt(portStr, 10) : null;
if (portStr && (port === null || Number.isNaN(port))) {
  // Fail soft: don't crash-loop on a typo'd port. Fall back to stdio
  // (the MCP_PORT-unset behavior) and say so loudly.
  console.error(
    `filesystem-mcp: invalid MCP_PORT: "${portStr}" — falling back to stdio transport`,
  );
  port = null;
}

if (port) {
  const httpApp = express();
  httpApp.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  httpApp.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (
        !sessionId &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };
        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Bad Request: missing or unknown session, or non-initialize POST",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  httpApp.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      transport: "http",
      port,
      roots: config.roots.length,
      allow_write: config.allowWrite,
    });
  });

  httpApp.listen(port, () => {
    console.error(`filesystem-mcp HTTP transport listening on :${port}`);
  });
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
