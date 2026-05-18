# Findings & Bug Log — propstack-mcp

> Logged during live MCP session on 2026-05-15/16.
> All write tests used Cursor's `user-propstack` MCP connection pointing at the locally compiled server.

---

## Bugs Found

### BUG-01 — `write_pin` gatekeeper is bypassed by the agent

**Severity:** Critical  
**File:** `src/tools/helpers.ts`, `src/tools/properties.ts`, `src/tools/relationships.ts`, `src/tools/contacts.ts`, `src/tools/deals.ts`, `src/tools/tasks.ts`

**What happened:**  
`create_property`, `create_contact`, and `create_ownership` all executed successfully **without** the agent ever asking the user for a PIN. The `WRITE_PIN=1234` was set in `.env`, and `verifyWritePin()` exists in every write handler — but it did not block anything.

**Root cause:**  
The protection is **prompt-only / honor-system**. The tool description text says "STOP — ask the user for their write_pin before calling this tool." But:
1. The AI model decided it could infer or skip it.
2. The MCP SDK does not enforce the Zod `z.string()` field as a hard pre-condition at the transport layer — it passes `undefined` through to the handler.
3. `verifyWritePin(undefined)` with `WRITE_PIN` set *should* block — but the agent can still call the tool and the compiled dist may be out of sync with what Cursor's MCP descriptor cache shows (the JSON files in `mcps/user-propstack/tools/` do **not** include `write_pin` at all, so Cursor never presents it as a parameter).

**Effect:** Any write or delete can be executed without any human confirmation. Since Propstack has no rollback, this is a critical data-integrity risk.

**Fix needed:** See Security Design Proposal below.

---

### BUG-02 — `create_property` / `update_property` send wrong field name for status

**Severity:** Medium  
**File:** `src/tools/properties.ts`  
**Status:** Fixed in session (2026-05-15)

**What happened:**  
The Propstack API rejected `{ "status": 156854 }` with:
```
400: {"errors":["unknown attribute 'status' for Property."]}
```

**Root cause:**  
The API expects `property_status_id`, not `status`. The TypeScript source used `status` as the field name for both input schema labeling and API payload.

**Fix applied:**  
Both `create_property` and `update_property` now extract `status` from args and remap it to `property_status_id` in the payload before the API call.

```typescript
// Before
const { write_pin: _, ...propertyArgs } = args;
client.post("/units", { body: { property: stripUndefined(propertyArgs) } });

// After
const { write_pin: _, status, ...propertyArgs } = args;
const payload = { ...propertyArgs };
if (status !== undefined) payload["property_status_id"] = status;
client.post("/units", { body: { property: stripUndefined(payload) } });
```

---

### BUG-03 — `create_ownership` / `create_partnership` response is all `undefined`

**Severity:** Low (cosmetic — the write still succeeds)  
**File:** `src/tools/relationships.ts`  
**Status:** Fixed in session (2026-05-15)

**What happened:**  
After a successful ownership creation, the response read:
```
Ownership created (ID: undefined).
Contact undefined is now owner of property undefined.
```

**Root cause:**  
The Propstack API wraps the response in an object (e.g., `{ ownership: { id, client_id, property_id } }`). The code was typed as `PropstackRelationship` directly, so all fields came back `undefined`.

**Fix applied:**  
Added an `unwrapRelationship()` helper that checks for wrapper keys (`ownership`, `partnership`, `relationship`) and falls back to the input `args` IDs:

```typescript
function unwrapRelationship(raw: unknown): PropstackRelationship {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const key of ["ownership", "partnership", "relationship"]) {
      if (r[key] && typeof r[key] === "object") return r[key] as PropstackRelationship;
    }
  }
  return raw as PropstackRelationship;
}
```

---

### BUG-04 — `create_property` response shows "Untitled" immediately after creation

**Severity:** Low (cosmetic)  
**File:** `src/tools/properties.ts`

**What happened:**  
After `create_property`, the returned formatted text showed `**Untitled** (ID: 5444929)` with no address or rooms, even though the data was correct when fetched with `get_property`.

**Root cause:**  
The Propstack `POST /units` response apparently does not return the full object — it returns a minimal representation. The `formatProperty()` call on the response therefore shows empty fields.

**Fix needed:**  
After a successful POST, fetch the full property with a `GET /units/:id` call before formatting the response. This costs one extra API round-trip but gives the user accurate confirmation.

---

### BUG-05 — `list_documents` fails with "Invalid API key" while other tools succeed

**Severity:** Medium  
**File:** `src/tools/documents.ts`

**What happened:**  
`list_documents({ property_id: 5429930 })` returned:
```
Invalid API key. Check your PROPSTACK_API_KEY. Manage keys at crm.propstack.de/app/admin/api_keys
```
…while `get_property`, `search_deals`, and `search_activities` on the same property all worked fine in the same session.

**Root cause:**  
Propstack API keys can be scoped per endpoint. The active key does not have permission for `GET /documents`.

**Fix needed:**  
Go to **crm.propstack.de → Admin → API-Keys**, open the key in use, and enable the `documents` endpoint. Same check for `ownerships` and `partnerships` if they show the same error.

---

### BUG-06 — `search_properties` ignores `per_page` parameter

**Severity:** Low  
**Status:** Suspected — not yet confirmed as a server-side or client-side issue

**What happened:**  
`search_properties({ sort_by: "created_at", order: "desc", per_page: 2 })` returned 20 rows instead of 2.

**Root cause (suspected):**  
The `per_page` param may be mapped to `per` at the API level (Propstack uses both `per_page` and `per` depending on the endpoint). Or the API ignores small values.

**Fix needed:**  
Verify the correct query param name for the `/units` endpoint in the Propstack docs. If needed, add a client-side slice after fetching.

---

## Security Design Proposal — Write Operation Gatekeeper

### Why the current `write_pin` approach fails

The current design is a **prompt-level hint**: the tool description text tells the model to ask for a PIN. This is not a technical gate — a model can ignore it, misread it, or the MCP client may not surface the description at all. Additionally, the `write_pin` field is absent from the JSON descriptor files Cursor uses for tool discovery, so Cursor never presents it as a required parameter.

**Fundamental rule:** *Security controls that rely on an LLM reading a text instruction are not security controls.*

---

### Recommended Architecture: Thin Confirmation Middleware

The safest approach for a single-user stdio MCP server (no external gateway) is a **two-phase tool pattern**: separate the *intent declaration* from the *execution*, with a required confirmation step in between.

```
Agent calls write tool
        │
        ▼
┌──────────────────────┐
│  STAGE 1 (dry-run)   │  Tool returns a human-readable preview of what
│  No API call made    │  WOULD happen, plus a one-time token.
└──────────┬───────────┘
           │ Returns preview + confirm_token
           ▼
     User sees preview in Cursor chat
           │
           │ User explicitly types "confirm" or provides token
           ▼
┌──────────────────────┐
│  STAGE 2 (execute)   │  Agent calls confirm_write(token) — only then
│  Actual API call     │  does the real API mutation happen.
└──────────────────────┘
```

#### Option A — `confirm_write` tool (pragmatic, works today)

Add a single new tool `confirm_write` and a server-side pending-operation store:

```typescript
// In-memory store: token → pending operation
const pendingOps = new Map<string, {
  tool: string;
  summary: string;
  execute: () => Promise<string>;
  expiresAt: number;
}>();

// All write tools call this instead of the API directly
async function stageMutation(
  toolName: string,
  summary: string,        // "Create property: Musterstraße 1, Berlin, 350.000 €"
  execute: () => Promise<string>
): Promise<ToolResult> {
  const token = crypto.randomUUID().slice(0, 8).toUpperCase();
  pendingOps.set(token, {
    tool: toolName,
    summary,
    execute,
    expiresAt: Date.now() + 5 * 60 * 1000,  // 5 min TTL
  });

  return textResult(
    `⚠️  PENDING — ${toolName}\n\n` +
    `${summary}\n\n` +
    `This will make a permanent change in Propstack (no rollback).\n` +
    `To execute, call: confirm_write("${token}")\n` +
    `Token expires in 5 minutes.`
  );
}

// The confirmation tool
server.registerTool("confirm_write", {
  title: "Confirm Write Operation",
  description: "Execute a previously staged write operation. Only call this after showing the user what will happen and getting their explicit approval.",
  inputSchema: {
    token: z.string().describe("The confirmation token returned by the staged write tool"),
  }
}, async ({ token }) => {
  const op = pendingOps.get(token);
  if (!op) return textResult("Token not found or expired. Re-run the write tool to get a new token.");
  if (Date.now() > op.expiresAt) {
    pendingOps.delete(token);
    return textResult("Token expired. Re-run the write tool to get a new token.");
  }
  pendingOps.delete(token);
  return textResult(await op.execute());
});
```

**Why this works:**
- The first call never touches the API — the agent literally cannot mutate data in one shot.
- The token is short-lived and single-use.
- The user sees a plain-language summary before confirming.
- No external service needed — it's all in-process.

#### Option B — MCP Elicitation (spec-native, future-proof)

MCP spec `2025-06-18` introduced `elicitation/create` — a server-initiated structured input request. The server can pause mid-tool and ask the client (Cursor) to render a confirmation form to the user.

```typescript
// Inside a write tool handler, before the API call:
const confirmation = await server.elicitInput({
  message: `Confirm: Create property at Musterstraße 1, Berlin for 350.000 €?\nThis cannot be undone.`,
  requestedSchema: {
    type: "object",
    properties: {
      confirmed: {
        type: "boolean",
        title: "I confirm this action",
        default: false,
      }
    },
    required: ["confirmed"]
  }
});

if (!confirmation || confirmation.action !== "accept" || !confirmation.content?.confirmed) {
  return textResult("Operation cancelled by user.");
}

// Proceed with API call
```

**Limitations today:** Cursor's MCP client support for `elicitation/create` is not yet confirmed. Check the `elicitation` capability in the negotiated client capabilities before using.

#### Option C — External Approval Webhook (for team/enterprise use)

For a multi-user or team deployment, route all write operations through a small approval service:

```
Write tool called
      │
      ▼
POST /approvals (approval service)
      │  Returns approval_id
      ▼
Slack / email / webhook notifies approver
      │
      ▼
Approver clicks "Approve" → approval service records decision
      │
      ▼
MCP server polls GET /approvals/:id until approved/rejected (with timeout)
      │
      ▼
Execute or abort
```

Reference implementation: [permission-protocol/mcp-guard](https://github.com/permission-protocol/mcp-guard) — YAML-based policy with `allow`, `block`, and `require_approval` actions.

---

### Tool Risk Classification

Use this table when implementing any gatekeeper to know which tools need which level of protection:

| Risk | Tools | Gate |
|------|-------|------|
| **Destructive** (no undo) | `delete_contact`, `delete_search_profile`, `delete_webhook` | Require token confirmation + summary |
| **Mutating** (data changes) | `create_property`, `update_property`, `create_contact`, `update_contact`, `create_deal`, `update_deal`, `create_task`, `update_task` | Require token confirmation + summary |
| **Linking** | `create_ownership`, `create_partnership`, `send_email` | Require token confirmation |
| **Read-only** | `search_*`, `get_*`, `list_*`, `export_data` | No gate — execute immediately |

---

### Additional Hardening Checklist

- [ ] **Implement Option A** (`confirm_write` staging tool) — lowest effort, highest impact
- [ ] **Remove `write_pin` from tool schemas** — it doesn't work and gives false confidence
- [ ] **Fix BUG-02** (already done) — rebuild and restart MCP server
- [ ] **Fix BUG-03** (already done) — rebuild and restart MCP server
- [ ] **Fix BUG-04** — add `GET /units/:id` after successful POST in `create_property`
- [ ] **Fix BUG-05** — enable `documents` (and `ownerships`/`partnerships`) in Propstack API key permissions
- [ ] **Fix BUG-06** — verify correct `per_page` vs `per` param for `/units` endpoint
- [ ] **Add per-tool rate limiting** — prevent runaway agent loops from hammering the CRM (e.g., max 10 write calls per minute)
- [ ] **Add an audit log** — append every write + its args to a local `audit.jsonl` file with timestamp, so there's at least a trail even without rollback
- [ ] **Test MCP elicitation capability** — check if Cursor declares `elicitation` in its MCP handshake; if yes, Option B is the cleanest long-term solution

---

## References

- MCP Elicitation Spec (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- MCP Governance / Policy Gates (2026): https://cordum.io/blog/mcp-governance-servers
- MCP Gateway Security Guide (2026): https://rapidclaw.dev/blog/mcp-gateway-security-guide-2026
- Cloudflare Human-in-the-Loop patterns: https://developers.cloudflare.com/agents/guides/human-in-the-loop/
- mcp-guard reference implementation: https://github.com/permission-protocol/mcp-guard
- GitHub MCP Server — per-tool confirmation: https://github.com/github/github-mcp-server/issues/798
