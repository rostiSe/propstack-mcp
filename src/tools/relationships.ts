import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PropstackClient } from "../propstack-client.js";
import type { PropstackRelationship } from "../types/propstack.js";
import { textResult, errorResult } from "./helpers.js";
import { stageMutation } from "./gatekeeper.js";

function unwrapRelationship(raw: unknown): PropstackRelationship {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    // API may wrap in { ownership: {...} }, { partnership: {...} }, or { relationship: {...} }
    for (const key of ["ownership", "partnership", "relationship"]) {
      if (r[key] && typeof r[key] === "object") return r[key] as PropstackRelationship;
    }
  }
  return raw as PropstackRelationship;
}

// ── Tool registration ────────────────────────────────────────────────

export function registerRelationshipTools(server: McpServer, client: PropstackClient): void {
  // ── create_ownership ────────────────────────────────────────────

  server.registerTool(
    "create_ownership",
    {
      title: "Create Ownership",
      description: `Link a contact as the OWNER (Eigentümer) of a property.

Use this tool to:
- Record property ownership ("Herr Müller owns Hauptstraße 12")
- Set up owner relationships for acquisition properties
- Link sellers to their properties

The ownership appears on both the contact's and the property's record.`,
      inputSchema: {
        client_id: z.number()
          .describe("Contact ID (the owner)"),
        property_id: z.number()
          .describe("Property ID (the owned property)"),
      },
    },
    async (args) => {
      const summary =
        `Link contact #${args.client_id} as OWNER of property #${args.property_id}`;

      return stageMutation("create_ownership", summary, async () => {
        const raw = await client.post<unknown>("/ownerships", { body: args });
        const rel = unwrapRelationship(raw);
        return (
          `Ownership created (ID: ${rel.id ?? "—"}).\n` +
          `Contact ${rel.client_id ?? args.client_id} is now owner of property ${rel.property_id ?? args.property_id}.`
        );
      });
    },
  );

  // ── create_partnership ──────────────────────────────────────────

  server.registerTool(
    "create_partnership",
    {
      title: "Create Partnership",
      description: `Link a contact as a PARTNER (buyer, tenant, etc.) to a property.

Use this tool to:
- Link a buyer to a property ("Frau Schmidt is the buyer of Hauptstraße 12")
- Link a tenant to a rental property
- Create any named contact↔property relationship

The name field describes the role (e.g. "Käufer", "Mieter", "Verwalter").`,
      inputSchema: {
        client_id: z.number()
          .describe("Contact ID (the partner)"),
        property_id: z.number()
          .describe("Property ID"),
        name: z.string().optional()
          .describe("Role name (e.g. 'Käufer', 'Mieter', 'Verwalter')"),
      },
    },
    async (args) => {
      const role = args.name ? ` as "${args.name}"` : "";
      const summary =
        `Link contact #${args.client_id} to property #${args.property_id}${role} (partnership)`;

      return stageMutation("create_partnership", summary, async () => {
        const rawP = await client.post<unknown>("/partnerships", { body: args });
        const rel = unwrapRelationship(rawP);
        const roleFmt = rel.name ? ` as "${rel.name}"` : "";
        return (
          `Partnership created (ID: ${rel.id ?? "—"}).\n` +
          `Contact ${rel.client_id ?? args.client_id} linked to property ${rel.property_id ?? args.property_id}${roleFmt}.`
        );
      });
    },
  );
}
