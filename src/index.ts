#!/usr/bin/env node
import { promises as fsp } from "node:fs";
import * as path from "node:path";
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

function parseRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

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
    console.error(`Invalid ${name}: ${raw}`);
    process.exit(1);
  }
  return n;
}

async function buildConfig(): Promise<FilesystemConfig> {
  const declaredRoots = parseRoots(process.env.FS_ROOTS);
  if (declaredRoots.length === 0) {
    console.error(
      "FS_ROOTS environment variable is required (comma-separated absolute paths).",
    );
    process.exit(1);
  }

  // Resolve roots through realpath() once at startup. Refuse non-absolute,
  // non-existent, and non-directory entries — these are configuration
  // mistakes that should fail loudly.
  const resolvedRoots: string[] = [];
  for (const r of declaredRoots) {
    if (!path.isAbsolute(r)) {
      console.error(`FS_ROOTS entries must be absolute paths: ${r}`);
      process.exit(1);
    }
    let real: string;
    try {
      real = await fsp.realpath(r);
    } catch {
      console.error(`FS_ROOTS entry does not exist: ${r}`);
      process.exit(1);
    }
    const st = await fsp.stat(real);
    if (!st.isDirectory()) {
      console.error(`FS_ROOTS entry is not a directory: ${r} (real: ${real})`);
      process.exit(1);
    }
    resolvedRoots.push(real);
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
const port = portStr ? Number.parseInt(portStr, 10) : null;
if (portStr && (port === null || Number.isNaN(port))) {
  console.error(`Invalid MCP_PORT: ${portStr}`);
  process.exit(1);
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
