# HeidiFi MCP Server — Tool Roadmap

Tracks tools not yet built. **Tier 1 (read essentials) is done** — see `src/mcp/tools/`.

Two data paths, both proven in this codebase:
- **Read tools** → query Firestore directly, scoped by `tenantUserId` (the Tier 1 pattern).
- **Write/action tools** → call the captive-server `/internal/*` endpoints with `INTERNAL_API_SECRET`,
  passing the token's `tenantUserId`. Reuses tested business logic (campaign state machine,
  audience materialization, ownership re-checks) instead of duplicating it in the MCP layer.

---

## Tier 2 — Campaign & messaging actions (write, via `/internal/*`)

Requires giving the MCP server the `INTERNAL_API_SECRET` env var and forwarding `tenantUserId`.

- [ ] `send_campaign` → `POST /internal/campaigns/send`
- [ ] `pause_campaign` → `POST /internal/campaigns/pause`
- [ ] `resume_campaign` → `POST /internal/campaigns/resume`
- [ ] `cancel_campaign` → `POST /internal/campaigns/cancel`
- [ ] `send_test_message` → `POST /internal/test-send` (email / sms / whatsapp)

⚠️ These genuinely send messages to real guests. Gate behind a distinct OAuth scope
(`campaigns:write`, `messaging:send`) and make the "this will send" effect explicit in each
tool description.

## Tier 3 — Network / UniFi (via `/internal/unifi/*`)

- [ ] `get_device_status` → `POST /internal/unifi/device-status` (live AP status, model, uptime)
- [ ] `configure_venue_wifi` → `POST /internal/unifi/apply-wifi` (apply an SSID to a venue) — write
- [ ] `detach_access_point` → `POST /internal/unifi/detach` — write

## Tier 4 — Needs new backend plumbing (no captive-server endpoint today; CMS-only)

- [ ] `create_campaign` / `update_campaign`
- [ ] `update_venue_marketing_config`
- [ ] `update_splash_config`

Each needs a new captive-server endpoint (or a guarded direct Firestore write) before an MCP tool
can exist.

---

## Cross-cutting follow-ups

- [ ] **OAuth scope taxonomy.** Replace the single `access_points:read` (in `src/config.ts` SCOPES,
      `src/middleware/bearer.ts`, and the CMS consent screen) with per-domain scopes:
      `venues:read`, `guests:read`, `campaigns:read`, `campaigns:write`, `messaging:send`,
      `network:write`. Coordinate with the CMS consent UI.
- [ ] Enforce scopes in tool handlers once the taxonomy exists (Tier 1 currently does not check scopes).
- [ ] Add a README / tool-catalog doc for the MCP server.
- [ ] After deploying new tools, redeploy `mcp.heidifi.ai` (Coolify) to pick them up.

## Notes / gotchas

- MCP SDK 1.29 + zod 3.25 trip `TS2589` ("type instantiation excessively deep") on `server.tool()`
  with an input schema. Register schema-bearing tools via the `addTool()` wrapper in `src/mcp/shared.ts`.
- Guests (`CaptivePortal_Users`) are keyed by `captivePortalAccessPointId`, not `tenantUserId` — resolve
  venues → APs → guests, and chunk Firestore `in` queries at 30 (`getGuestsForApIds` in `shared.ts`).
