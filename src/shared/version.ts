// CANONICAL SHARED FILE — standard MCP-S01 / MCP-T03. Copied verbatim into
// every ts-mcp-server repo; /repo-standards-audit hash-compares it.
//
// The ONE place the server version lives in code.
//
// Eight of nine servers in the fleet hardcoded this string in src/index.ts as
// well as package.json; one had three copies. The best of them carried a
// comment asking the next person to keep them in step — which is a request, not
// a mechanism, and has no failure mode when ignored.
//
// version-sync.test.ts asserts this equals package.json. Bump both in the same
// commit; the test fails the moment they diverge.
export const SERVER_VERSION = "0.1.0";
