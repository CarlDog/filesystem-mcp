#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express, { type Request, type Response } from "express";
import {
  FilesystemClient,
  type FilesystemConfig,
} from "./clients/filesystem.js";
import { parseRoots, deriveRootsFromVolumes, resolveRoots } from "./config.js";
import { registerFilesystemTools } from "./tools/index.js";
import { mountMcpHttp } from "./shared/http-transport.js";
import { loadBaseConfig } from "./shared/config.js";
import { logger, setLogLevel, type LogLevel } from "./shared/log.js";
import { SERVER_VERSION } from "./shared/version.js";

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

  // FS_DENY_FILE_PATTERNS backs a safety control: an empty list means NO
  // filenames are excluded, i.e. the sensitive-file filter is fully off.
  // An unset var falls back to the default (safe); an explicitly-set var
  // that parses to nothing (e.g. "") must fail loudly rather than
  // silently disabling the filter — same posture as the empty-roots
  // check above.
  const denyPatterns = parseDenyPatterns(process.env.FS_DENY_FILE_PATTERNS);
  if (
    process.env.FS_DENY_FILE_PATTERNS !== undefined &&
    denyPatterns.length === 0
  ) {
    console.error(
      "filesystem-mcp: FS_DENY_FILE_PATTERNS is set but contains no usable " +
        "entries. Leave it unset to use the default " +
        `(${DEFAULT_DENY_PATTERNS.join(", ")}); refusing to start with the ` +
        "sensitive-file filter silently disabled.",
    );
    process.exit(1);
  }

  return {
    roots: resolvedRoots,
    denyPatterns,
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
      version: SERVER_VERSION,
    },
    {
      instructions: INSTRUCTIONS,
    },
  );
  registerFilesystemTools(server, fsClient, { allowWrite: config.allowWrite });
  return server;
}

// loadBaseConfig() throws on a malformed value for a var it treats as a
// safety control (e.g. MCP_ALLOWED_HOSTS set-but-empty) or an unparseable
// MCP_PORT. Under restart: unless-stopped a bare throw here would surface
// as an opaque unhandled-rejection stack instead of a clear one-line
// reason — catch it and exit deliberately.
let baseConfig;
try {
  baseConfig = loadBaseConfig();
} catch (err) {
  console.error(
    `filesystem-mcp: invalid HTTP transport config: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

setLogLevel(baseConfig.logLevel as LogLevel);
const log = logger("main");

if (baseConfig.port === undefined) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log.info("filesystem-mcp ready on stdio", { version: SERVER_VERSION });
} else {
  if (!baseConfig.allowedHosts || baseConfig.allowedHosts.length === 0) {
    log.warn(
      "MCP_ALLOWED_HOSTS is unset — falling back to " +
        "localhost,127.0.0.1,[::1],host.docker.internal, which rejects a " +
        "real LAN client. Recommended: set it to the bare hostnames " +
        "clients use to reach this server (e.g. your NAS hostname and " +
        "host.docker.internal) — no port. Host headers are matched " +
        "case-insensitively, independent of port, with bracketed IPv6 " +
        "supported.",
    );
  }
  if (!baseConfig.authToken) {
    log.warn(
      "MCP_AUTH_TOKEN is unset — the HTTP endpoint has no bearer-auth " +
        "check. Recommended: set it, especially with FS_ALLOW_WRITE=true.",
    );
  }

  const httpApp = express();
  httpApp.use(express.json());

  httpApp.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      transport: "http",
      port: baseConfig.port,
      roots: config.roots.length,
      allow_write: config.allowWrite,
    });
  });

  const mcp = mountMcpHttp(httpApp, "/mcp", {
    createServer,
    authToken: baseConfig.authToken,
    allowedHosts: baseConfig.allowedHosts,
    sessionIdleMs: baseConfig.sessionIdleMs,
  });

  const httpServer = httpApp.listen(
    baseConfig.port,
    baseConfig.bindHost,
    () => {
      log.info("filesystem-mcp ready on http", {
        version: SERVER_VERSION,
        bind: `${baseConfig.bindHost}:${baseConfig.port}`,
        auth: baseConfig.authToken ? "bearer" : "none",
        allowedHosts: baseConfig.allowedHosts?.join(",") ?? "any",
      });
    },
  );

  const shutdown = async (signal: string): Promise<void> => {
    log.info("shutting down", { signal });
    await mcp.dispose();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
