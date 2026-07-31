# HeidiFi MCP Server — Tool Roadmap

Tracks tools not yet built. **Tier 1 (read essentials) is done** — see `src/mcp/tools/`.

Two data paths, both proven in this codebase:
- **Read tools** → query Firestore directly, scoped by `tenantUserId` (the Tier 1 pattern).
- **Write/action tools** → call the captive-server `/internal/*` endpoints with `INTERNAL_API_SECRET`,
  passing the token's `tenantUserId`. Reuses tested business logic (campaign state machine,
  audience materialization, ownership re-checks) instead of duplicating it in the MCP layer.

---

## Tier 2 — Campaign & messaging actions (write, via `/internal/*`) — DONE

Requires giving the MCP server the `INTERNAL_API_SECRET` env var and forwarding `tenantUserId`.

- [x] `send_campaign` → `POST /internal/campaigns/send`
- [x] `pause_campaign` → `POST /internal/campaigns/pause`
- [x] `resume_campaign` → `POST /internal/campaigns/resume`
- [x] `cancel_campaign` → `POST /internal/campaigns/cancel`
- [x] `test_send_campaign` → `POST /internal/test-send` (email / sms / whatsapp)

⚠️ These genuinely send messages to real guests. Gate behind a distinct OAuth scope
(`campaigns:write`, `messaging:send`) and make the "this will send" effect explicit in each
tool description.

## Tier 3 — Network / UniFi (via `/internal/unifi/*`)

- [ ] `get_device_status` → `POST /internal/unifi/device-status` (live AP status, model, uptime)
- [ ] `configure_venue_wifi` → `POST /internal/unifi/apply-wifi` (apply an SSID to a venue) — write
- [ ] `detach_access_point` → `POST /internal/unifi/detach` — write

## Tier 4 — Needs new backend plumbing (no captive-server endpoint today; CMS-only)

- [x] `create_campaign` / `update_campaign` — guarded direct Firestore writes, with the CMS
      validator hand-ported into `src/validation/campaigns.ts`.
- [ ] `update_venue_marketing_config`
- [x] **Splash configuration** — `start_splash_setup`, `list_splash_templates`, `list_venue_logos`,
      `preview_splash_config`, `apply_splash_config`, `copy_splash_config`, plus a widened
      `get_splash_config` (it used to return 7 of ~16 fields).

      Took the third option rather than either of the two above: these tools call **the CMS**
      (`src/cmsClient.ts` → `/api/captive-portal/internal/splash-*`). The splash validator is ~350
      lines of coercion rules whose shape is already mirrored in six places and whose consent
      defaults must stay byte-identical to the portal templates, so a hand-port here would have been
      the seventh copy and the riskiest one. Calling the CMS also gets the template registry with
      real descriptions and the tenant's CDN media library, neither of which exists on this side.

      Two things worth knowing before touching it:
      - `preview_splash_config` writes nothing and returns a diff, the warnings for everything the
        validator silently coerced, a `?draft=` preview link, and a `confirmToken`.
        `apply_splash_config` refuses any config whose token does not match — that is what stops an
        agent overwriting a live splash screen the tenant never saw.
      - The guided question script lives in `src/mcp/splashInterview.ts` and ships **in the tool
        result**, because these tools are MCP-only (no ChatGPT app, no Claude plugin) and so have no
        client-side skill bundle to carry it.

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
