import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "./helpers.js";

// ── Pending operations store ─────────────────────────────────────────

interface PendingOp {
  tool: string;
  summary: string;
  execute: () => Promise<string>;
  expiresAt: number;
}

const pendingOps = new Map<string, PendingOp>();
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateToken(): string {
  return randomBytes(3).toString("hex").toUpperCase(); // e.g. "A3F9B2"
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, op] of pendingOps) {
    if (now > op.expiresAt) pendingOps.delete(token);
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Stage a write operation for user confirmation.
 * Returns a preview + token instead of executing immediately.
 * The actual API call is deferred until confirm_write is called.
 */
export async function stageMutation(
  toolName: string,
  summary: string,
  execute: () => Promise<string>,
): Promise<ReturnType<typeof textResult>> {
  purgeExpired();
  const token = generateToken();
  pendingOps.set(token, { tool: toolName, summary, execute, expiresAt: Date.now() + TOKEN_TTL_MS });

  return textResult(
    `⚠️  PENDING WRITE — ${toolName}\n\n` +
    `${summary}\n\n` +
    `This will permanently change data in Propstack (no rollback).\n` +
    `To proceed, call confirm_write with token: **${token}**\n` +
    `Token expires in 5 minutes and is single-use.`,
  );
}

// ── confirm_write tool ───────────────────────────────────────────────

export function registerConfirmWriteTool(server: McpServer): void {
  server.registerTool(
    "confirm_write",
    {
      title: "Confirm Write Operation",
      description: `Execute a previously staged write operation.

Always show the user the pending operation summary before calling this.
Only call after the user has explicitly confirmed they want to proceed.

The token was provided in the previous tool response.
Tokens expire after 5 minutes and are single-use.`,
      inputSchema: {
        token: z.string()
          .describe("The confirmation token (e.g. 'A3F9B2') returned by the staged write tool"),
      },
    },
    async ({ token }) => {
      const key = token.trim().toUpperCase();
      const op = pendingOps.get(key);

      if (!op) {
        return textResult(
          `Token "${key}" not found or already used.\n` +
          `Re-run the write tool to generate a new token.`,
        );
      }
      if (Date.now() > op.expiresAt) {
        pendingOps.delete(key);
        return textResult(
          `Token "${key}" has expired.\n` +
          `Re-run the write tool to generate a new token.`,
        );
      }

      pendingOps.delete(key);

      try {
        const result = await op.execute();
        return textResult(`✅ ${op.tool} executed successfully.\n\n${result}`);
      } catch (err) {
        return textResult(`❌ ${op.tool} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
