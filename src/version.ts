/**
 * Single source of truth for the reported version.
 *
 * The same number appears in three places: the MCP server handshake, the
 * startup log line, and the release artefacts. Keeping it in one constant and
 * asserting it against package.json in the test suite means a release can never
 * go out with a mismatched version.
 */
export const VERSION = '0.4.0';
