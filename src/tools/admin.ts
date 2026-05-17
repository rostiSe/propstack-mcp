import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PropstackClient } from "../propstack-client.js";
import type { PropstackWebhook, PropstackProperty } from "../types/propstack.js";
import { textResult, errorResult, fmt, fmtPrice } from "./helpers.js";
import { stageMutation } from "./gatekeeper.js";

// ── Tool registration ────────────────────────────────────────────────

export function registerAdminTools(server: McpServer, client: PropstackClient): void {
  // ── list_webhooks ───────────────────────────────────────────────

  server.registerTool(
    "list_webhooks",
    {
      title: "List Webhooks",
      description: `List all configured webhooks in Propstack.

Returns each webhook with its URL, subscribed events, active status,
and HMAC secret. Use to review existing automation triggers.`,
      inputSchema: {},
    },
    async () => {
      try {
        const raw = await client.get<{ hooks: PropstackWebhook[] } | PropstackWebhook[]>("/hooks");
        const hooks = Array.isArray(raw) ? raw : raw?.hooks ?? [];

        if (hooks.length === 0) {
          return textResult("No webhooks configured.");
        }

        const lines = hooks.map((h) => {
          const parts: (string | null)[] = [
            `**Webhook #${h.id}**`,
            `  URL: ${fmt(h.target_url)}`,
            `  Event: ${fmt(h.event)}`,
            `  Active: ${h.active !== false ? "yes" : "no"}`,
            h.secret ? `  Secret: ${h.secret}` : null,
          ];
          return parts.filter(Boolean).join("\n");
        });

        return textResult(`Webhooks:\n\n${lines.join("\n\n")}`);
      } catch (err) {
        return errorResult("Webhook", err);
      }
    },
  );

  // ── create_webhook ──────────────────────────────────────────────

  server.registerTool(
    "create_webhook",
    {
      title: "Create Webhook",
      description: `Create a webhook to subscribe to Propstack CRM events.

Propstack will POST a JSON payload to target_url whenever the event
fires. Use HMAC verification (secret in response) to validate payloads.

Common events:
- CLIENT_CREATED — new contact added
- CLIENT_UPDATED — contact details changed
- PROPERTY_UPDATED — property details or status changed

Use this to set up automation triggers, e.g.:
"Notify me when any property status changes"
"Alert when a new contact is created"`,
      inputSchema: {
        event: z.string()
          .describe("Event name (e.g. 'CLIENT_CREATED', 'CLIENT_UPDATED', 'PROPERTY_UPDATED')"),
        target_url: z.string()
          .describe("URL that Propstack will POST to when the event fires"),
      },
    },
    async (args) => {
      const summary = `Create webhook: event "${args.event}" → ${args.target_url}`;

      return stageMutation("create_webhook", summary, async () => {
        const hook = await client.post<PropstackWebhook>(
          "/hooks",
          { body: { event: args.event, target_url: args.target_url } },
        );
        const lines: (string | null)[] = [
          `Webhook created (ID: ${hook.id}).`,
          `URL: ${fmt(hook.target_url)}`,
          `Event: ${fmt(hook.event, args.event)}`,
          `Active: ${hook.active !== false ? "yes" : "no"}`,
          hook.secret ? `HMAC Secret: ${hook.secret}` : null,
        ];
        return lines.filter(Boolean).join("\n");
      });
    },
  );

  // ── delete_webhook ──────────────────────────────────────────────

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete Webhook",
      description: `Delete a webhook subscription from Propstack.

Removes the webhook so Propstack will stop sending events to its URL.`,
      inputSchema: {
        id: z.number()
          .describe("Webhook ID to delete"),
      },
    },
    async (args) => {
      const summary = `⚠️  DELETE webhook #${args.id} (permanent)`;

      return stageMutation("delete_webhook", summary, async () => {
        await client.delete(`/hooks/${args.id}`);
        return `Webhook ${args.id} deleted.`;
      });
    },
  );

  // ── export_data ─────────────────────────────────────────────────

  server.registerTool(
    "export_data",
    {
      title: "Export Data",
      description: `Bulk export an entire data table from Propstack as JSON.

Useful for reporting, backup, migration, or analytics. Returns the
full contents of the selected table.

Available tables:
- Core: contacts, properties, projects, deals, saved_queries
- Activities: appointments, todos, notes, messages, cancelations
- Media: documents, images
- Organization: brokers, teams, departments, commission_splits
- Config: deal_pipelines, policies, relationships, property_details
- Lookup: groups, contact_sources, contact_reasons, contact_statuses,
  reservation_reasons, property_statuses`,
      inputSchema: {
        table: z.enum([
          "appointments", "brokers", "cancelations", "commission_splits",
          "contacts", "deal_pipelines", "deals", "departments",
          "documents", "images", "messages", "notes",
          "policies", "projects", "properties", "property_details",
          "relationships", "saved_queries", "teams", "todos",
          "groups", "contact_sources", "contact_reasons", "contact_statuses",
          "reservation_reasons", "property_statuses",
        ])
          .describe("Table name to export"),
      },
    },
    async (args) => {
      try {
        const data = await client.get<unknown>(
          `/datadump/${args.table}`,
        );

        if (Array.isArray(data)) {
          return textResult(`Exported ${data.length} rows from "${args.table}".\n\n${JSON.stringify(data, null, 2)}`);
        }

        return textResult(`Export of "${args.table}":\n\n${JSON.stringify(data, null, 2)}`);
      } catch (err) {
        return errorResult("Data export", err);
      }
    },
  );

  // ── get_contact_favorites ───────────────────────────────────────

  server.registerTool(
    "get_contact_favorites",
    {
      title: "Get Contact Favorites",
      description: `Get properties that a contact has favorited/bookmarked.

Returns the list of properties the contact has marked as favorites
in Propstack. Use to understand which listings a buyer is most
interested in.`,
      inputSchema: {
        contact_id: z.number()
          .describe("Contact ID"),
      },
    },
    async (args) => {
      try {
        const favorites = await client.get<PropstackProperty[]>(
          `/contacts/${args.contact_id}/favorites`,
        );

        if (!favorites || favorites.length === 0) {
          return textResult(`Contact ${args.contact_id} has no favorited properties.`);
        }

        const lines = favorites.map((p) => {
          const addr = [fmt(p.street, ""), fmt(p.house_number, "")].filter(Boolean).join(" ");
          const city = [fmt(p.zip_code, ""), fmt(p.city, "")].filter(Boolean).join(" ");
          const fullAddr = [addr, city].filter(Boolean).join(", ");
          const price = fmtPrice(p.price) !== "none"
            ? fmtPrice(p.price)
            : fmtPrice(p.base_rent) !== "none"
              ? fmtPrice(p.base_rent) + "/mo"
              : "no price";
          return `- **${fmt(p.title, "Untitled")}** (ID: ${p.id}) — ${fullAddr || "no address"} — ${price}`;
        });

        return textResult(`Favorited properties (${favorites.length}):\n\n${lines.join("\n")}`);
      } catch (err) {
        return errorResult("Contact favorites", err);
      }
    },
  );
}
