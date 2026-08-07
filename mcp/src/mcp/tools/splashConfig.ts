/**
 * Splash-screen configuration tools: let an agent design and publish the captive
 * portal for any venue the tenant owns.
 *
 * Every write goes through the CMS's secret-guarded internal API rather than
 * Firestore directly. The CMS owns the splash validator — the verification/login
 * field coupling, the byte-identical consent defaults, the silent-drop custom-field
 * rules — and that shape is already mirrored in six places. A seventh copy here
 * would drift, and the thing it would drift on is the legal text stored on every
 * guest record.
 *
 * The safety property these tools exist to hold: an agent can never overwrite a
 * live splash screen the tenant has not seen. preview_splash_config writes nothing
 * and returns a diff, the warnings for everything the validator quietly changed, a
 * renderable draft link, and a confirmToken; apply_splash_config refuses any config
 * whose token does not match.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NO_TENANT, addTool, errorResult, getOwnedVenue, jsonResult, tenantFrom } from '../shared';
import { callCmsInternal, cmsErrorMessage } from '../../cmsClient';
import { interviewPayload } from '../splashInterview';

const SPLASH_CONFIG_PATH = '/api/captive-portal/internal/splash-config';
const SPLASH_ASSETS_PATH = '/api/captive-portal/internal/splash-assets';
const SPLASH_DOCUMENTS_PATH = '/api/captive-portal/internal/splash-documents';

const DOCUMENT_TYPES = ['privacy_policy', 'terms_conditions'] as const;

type Raw = Record<string, unknown>;

/**
 * The splash config, loose on purpose. `passthrough()` plus a permissive nested
 * shape keeps this schema from becoming a second validator that disagrees with the
 * CMS's — the CMS coerces every field anyway, and preview_splash_config reports
 * whatever it changed. Being strict here would reject configs the real API accepts.
 */
const CONFIG_SCHEMA = z
  .object({
    templateId: z.string().optional().describe('One of the ids from list_splash_templates.'),
    title: z.string().optional().describe('Login-page headline, max 100 chars.'),
    subtitle: z.string().optional().describe('Login-page sub-line, max 250 chars. "" hides it.'),
    logoUrl: z.string().optional().describe('Must be an https *.b-cdn.net URL from list_venue_logos, or "" for the default logo.'),
    showLogo: z.boolean().optional(),
    primaryColor: z.string().optional().describe('6-digit hex, e.g. "#1c2b4a".'),
    backgroundColor: z.string().optional().describe('6-digit hex, e.g. "#ffffff".'),
    showMarketingOptIn: z.boolean().optional().describe('false skips the entire consent step.'),
    showPrivacyPolicy: z.boolean().optional(),
    showTermsOfService: z.boolean().optional(),
    loginPage: z.object({}).passthrough().optional(),
    consentPage: z.object({}).passthrough().optional(),
    verificationPage: z.object({}).passthrough().optional(),
    connectedPage: z.object({}).passthrough().optional(),
    languages: z
      .object({})
      .passthrough()
      .optional()
      .describe(
        'Multi-language setup: { enabled, default, fallback, autoDetect, available: ["en","de","it","fr"], '
        + 'translations: { de: { title?, subtitle?, loginPage?, consentPage?, verificationPage?, connectedPage? } } }. '
        + 'The TOP-LEVEL fields of this config are the default language\'s copy — a translation is a sparse '
        + 'overlay on them, and any field it omits falls back (selected → fallback → default), so a partial '
        + 'translation is safe. A translation may change WORDS ONLY: which fields exist, whether verification '
        + 'is on, colours and the template are shared across languages and are ignored inside a translation. '
        + 'Buttons, error messages and OTP copy are already translated by the portal — only translate wording '
        + 'the venue wrote. NEVER write or machine-translate consentPage.bodyParagraphs: that text is stored '
        + 'verbatim as each guest\'s consent record and must come from the tenant. Like the rest of this config, '
        + '`languages` is FULL REPLACE — always send the complete object, including translations you are not changing.',
      ),
  })
  .passthrough();

/** Ownership check, then the CMS call. Every tool here starts this way. */
async function withVenue(
  tenantUserId: string | null,
  venueId: string,
): Promise<{ ok: false; error: string } | { ok: true; tenantUserId: string }> {
  if (!tenantUserId) return { ok: false, error: NO_TENANT };
  const venue = await getOwnedVenue(tenantUserId, venueId);
  if (!venue) return { ok: false, error: 'Venue not found or not owned by this account.' };
  return { ok: true, tenantUserId };
}

async function cms(path: string, body: Raw) {
  const result = await callCmsInternal(path, body);
  if (result.status < 200 || result.status >= 300) {
    return { ok: false as const, error: cmsErrorMessage(result), data: result.data };
  }
  return { ok: true as const, data: result.data };
}

export function registerSplashConfigTools(server: McpServer): void {
  addTool<{ venueId: string }>(
    server,
    'start_splash_setup',
    'START HERE when the user wants to set up, redesign or change a venue\'s captive-portal splash screen. Returns everything needed to do it properly: the venue\'s current configuration, the tenant\'s saved brand, the templates that suit this kind of venue, the logos already uploaded, AND an ordered interview script with the questions to ask, the rules that are not obvious from the config shape, and the workflow to follow. Read the script and interview the user step by step — do not guess values or dump the whole config at them.',
    { venueId: z.string().describe('The venue id (from list_venues).') },
    async (args, extra) => {
      const gate = await withVenue(tenantFrom(extra), args.venueId);
      if (!gate.ok) return errorResult(gate.error);

      const [current, assets] = await Promise.all([
        cms(SPLASH_CONFIG_PATH, { tenantUserId: gate.tenantUserId, venueId: args.venueId, action: 'read' }),
        cms(SPLASH_ASSETS_PATH, {
          tenantUserId: gate.tenantUserId,
          venueId: args.venueId,
          include: ['branding', 'templates', 'media'],
        }),
      ]);

      if (!current.ok) return errorResult(current.error);
      if (!assets.ok) return errorResult(assets.error);

      return jsonResult({
        venue: current.data.venue ?? assets.data.venue ?? null,
        isFirstTimeSetup: current.data.exists === false,
        currentConfig: current.data.config,
        currentNotes: current.data.notes ?? [],
        livePreviewUrls: current.data.livePreviewUrls ?? null,
        branding: assets.data.branding ?? null,
        brandingNote: assets.data.brandingNote,
        availableLogos: assets.data.media ?? [],
        logoNote: assets.data.mediaNote,
        templates: assets.data.templates ?? [],
        interview: interviewPayload(),
      });
    },
  );

  addTool<{ venueId?: string; search?: string; category?: string }>(
    server,
    'list_splash_templates',
    'List the splash-screen designs a venue can use, with a name, description, keywords and a tryOnUrl that renders the design in a browser so the user can look at it before choosing. Pass venueId to order the list by what suits that venue type. Every template shows the same fields, so this is purely a visual choice.',
    {
      venueId: z.string().optional().describe('Order results by what suits this venue type.'),
      search: z.string().optional().describe('Filter by name, description or keyword — e.g. "dark", "restaurant", "minimal".'),
      category: z.string().optional().describe('Filter by category: airbnb, restaurant, modern, classic, other.'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);
      if (args.venueId) {
        const gate = await withVenue(tenantUserId, args.venueId);
        if (!gate.ok) return errorResult(gate.error);
      }

      const result = await cms(SPLASH_ASSETS_PATH, {
        tenantUserId,
        venueId: args.venueId,
        include: ['templates'],
      });
      if (!result.ok) return errorResult(result.error);

      let templates = (result.data.templates as Array<Raw> | undefined) ?? [];
      if (args.category) {
        const wanted = args.category.toLowerCase();
        templates = templates.filter((t) => String(t.category).toLowerCase() === wanted);
      }
      if (args.search) {
        const q = args.search.toLowerCase();
        templates = templates.filter((t) => {
          const haystack = [t.id, t.name, t.description, ...((t.keywords as string[]) ?? [])]
            .join(' ')
            .toLowerCase();
          return haystack.includes(q);
        });
      }

      return jsonResult({ count: templates.length, templates });
    },
  );

  addTool<{ venueId: string }>(
    server,
    'list_venue_logos',
    'List the images the tenant has already uploaded, as CDN URLs that are valid for a splash logo. A splash logoUrl is only accepted if it is an https URL on the Bunny CDN, and there is no way to import one from an arbitrary web address — so pick from this list, or ask the user to upload their logo under Media in the dashboard and call this again.',
    { venueId: z.string().describe('The venue id (from list_venues).') },
    async (args, extra) => {
      const gate = await withVenue(tenantFrom(extra), args.venueId);
      if (!gate.ok) return errorResult(gate.error);

      const result = await cms(SPLASH_ASSETS_PATH, {
        tenantUserId: gate.tenantUserId,
        venueId: args.venueId,
        include: ['media', 'branding'],
      });
      if (!result.ok) return errorResult(result.error);

      const media = (result.data.media as Array<Raw> | undefined) ?? [];
      return jsonResult({
        count: media.length,
        logos: media,
        note: result.data.mediaNote,
        brandLogoUrl: (result.data.branding as Raw | null)?.logoUrl ?? null,
      });
    },
  );

  addTool<{ venueId: string; config: Raw }>(
    server,
    'preview_splash_config',
    'DRY RUN — validates a proposed splash configuration and writes NOTHING. Returns: `normalized` (exactly what would be stored), `diff` (every field that would change), `warnings` (every value the validator silently coerced or dropped — ALWAYS read these, an empty array is the only proof the config is what you asked for), `notes` (valid settings with consequences worth mentioning), `previewUrls` (real links that render the PROPOSED design, one per page), and `confirmToken`. Call this before every apply, show the user the diff, the warnings and a preview link, and get an explicit yes. Send the COMPLETE config: the write is a full replace, so any key you omit is reset to its default.',
    {
      venueId: z.string().describe('The venue id (from list_venues).'),
      config: CONFIG_SCHEMA.describe('The complete proposed config. Start from start_splash_setup / get_splash_config and modify it.'),
    },
    async (args, extra) => {
      const gate = await withVenue(tenantFrom(extra), args.venueId);
      if (!gate.ok) return errorResult(gate.error);

      const result = await cms(SPLASH_CONFIG_PATH, {
        tenantUserId: gate.tenantUserId,
        venueId: args.venueId,
        action: 'validate',
        config: args.config,
      });
      if (!result.ok) return errorResult(result.error);

      return jsonResult({
        ...result.data,
        nextStep: 'Show the user the diff, anything in `warnings`, and a preview link. Once they explicitly agree, call apply_splash_config with this same config and the confirmToken.',
      });
    },
  );

  addTool<{ venueId: string; config: Raw; confirmToken: string }>(
    server,
    'apply_splash_config',
    'Save a splash configuration. LIVE IMMEDIATELY — the next guest who connects at any access point in this venue sees it. Requires the confirmToken from preview_splash_config for this exact config, and is refused if the config changed since it was previewed. Only call this after the user has seen the preview and explicitly said yes; never in the same turn as preview_splash_config unless they had already approved that exact change.',
    {
      venueId: z.string().describe('The venue id (from list_venues).'),
      config: CONFIG_SCHEMA.describe('The same complete config that was passed to preview_splash_config.'),
      confirmToken: z.string().describe('The confirmToken returned by preview_splash_config for this config.'),
    },
    async (args, extra) => {
      const gate = await withVenue(tenantFrom(extra), args.venueId);
      if (!gate.ok) return errorResult(gate.error);

      const result = await cms(SPLASH_CONFIG_PATH, {
        tenantUserId: gate.tenantUserId,
        venueId: args.venueId,
        action: 'apply',
        config: args.config,
        confirmToken: args.confirmToken,
      });

      if (!result.ok) {
        // The CMS hands back the correct token on a mismatch, so the model can
        // re-preview instead of guessing.
        const fresh = typeof result.data.confirmToken === 'string' ? result.data.confirmToken : null;
        return errorResult(
          fresh
            ? `${result.error}\n\nThe correct confirmToken for the config you sent is "${fresh}" — but do not just retry with it. Re-run preview_splash_config and confirm the change with the user first.`
            : result.error,
        );
      }

      return jsonResult({
        ...result.data,
        note: 'This is now live for guests. The livePreviewUrls render the saved config.',
      });
    },
  );

  addTool<{ fromVenueId: string; toVenueId: string; overrides?: Raw }>(
    server,
    'copy_splash_config',
    'Copy one venue\'s splash configuration onto another, optionally with changes (a different headline, say). This is a DRY RUN with the same output as preview_splash_config — it writes nothing and returns a diff, warnings, preview links and a confirmToken, so cloning still goes through the user before it goes live. Useful for rolling one approved design out across a tenant\'s venues.',
    {
      fromVenueId: z.string().describe('The venue to copy the design FROM.'),
      toVenueId: z.string().describe('The venue to apply it TO.'),
      overrides: CONFIG_SCHEMA.optional().describe('Top-level fields to change on the copy, e.g. a per-venue title.'),
    },
    async (args, extra) => {
      const tenantUserId = tenantFrom(extra);
      const from = await withVenue(tenantUserId, args.fromVenueId);
      if (!from.ok) return errorResult(`Source venue: ${from.error}`);
      const to = await withVenue(tenantUserId, args.toVenueId);
      if (!to.ok) return errorResult(`Target venue: ${to.error}`);

      if (args.fromVenueId === args.toVenueId) {
        return errorResult('The source and target venue are the same — nothing to copy.');
      }

      const source = await cms(SPLASH_CONFIG_PATH, {
        tenantUserId: from.tenantUserId,
        venueId: args.fromVenueId,
        action: 'read',
      });
      if (!source.ok) return errorResult(source.error);
      if (source.data.exists === false) {
        return errorResult(
          `The source venue has no splash configuration saved yet, so there is nothing to copy. Set that venue up first with start_splash_setup.`,
        );
      }

      // Shallow merge is right here: overrides are documented as top-level fields,
      // and deep-merging a page object would silently keep half of the source
      // venue's copy under a caller who meant to replace it.
      const config = { ...(source.data.config as Raw), ...(args.overrides ?? {}) };

      const result = await cms(SPLASH_CONFIG_PATH, {
        tenantUserId: to.tenantUserId,
        venueId: args.toVenueId,
        action: 'validate',
        config,
      });
      if (!result.ok) return errorResult(result.error);

      return jsonResult({
        copiedFrom: args.fromVenueId,
        ...result.data,
        nextStep: `Show the user what would change at the target venue, then call apply_splash_config(venueId: "${args.toVenueId}", config, confirmToken) once they agree. Note the logo is copied as-is — it stays valid because the CDN media library is shared across the tenant's venues.`,
      });
    },
  );

  // ── Terms & Privacy ──────────────────────────────────────────────────────
  // These are NOT part of the splash config document — they are venue-scoped
  // overrides in a separate collection, which is why they have their own tools.
  // A venue either publishes its own text or inherits the platform default.

  addTool<{ venueId: string }>(
    server,
    'get_venue_documents',
    'Read the venue\'s Terms & Conditions and Privacy Policy — the documents linked from the splash screen footer. For each one you get the venue\'s own version if it has published one, the platform default, and `inForce` telling you which the guests are actually being shown ("override", "platform_default" or "none"). Note the footer links only appear when showPrivacyPolicy / showTermsOfService are on in the splash config.',
    { venueId: z.string().describe('The venue id (from list_venues).') },
    async (args, extra) => {
      const gate = await withVenue(tenantFrom(extra), args.venueId);
      if (!gate.ok) return errorResult(gate.error);

      const result = await cms(SPLASH_DOCUMENTS_PATH, {
        tenantUserId: gate.tenantUserId,
        venueId: args.venueId,
        action: 'read',
      });
      if (!result.ok) return errorResult(result.error);
      return jsonResult(result.data);
    },
  );

  addTool<{ venueId: string; type: string; content: string; title?: string }>(
    server,
    'preview_venue_document',
    'DRY RUN for replacing a venue\'s Terms & Conditions or Privacy Policy. Writes NOTHING. Returns a summary of how the text would change and a confirmToken. This is the venue\'s LEGAL TEXT shown to guests — do not draft, translate or "improve" it yourself. Use the wording the tenant gives you, read the change back to them, and get an explicit yes before applying. If they want to go back to the platform default, use reset_venue_document rather than publishing a copy of it.',
    {
      venueId: z.string().describe('The venue id (from list_venues).'),
      type: z.enum(DOCUMENT_TYPES).describe('Which document to replace.'),
      content: z.string().describe('The full document text, supplied by the tenant. Max 100000 characters.'),
      title: z.string().optional().describe('Optional heading; defaults to "Privacy Policy" / "Terms & Conditions".'),
    },
    async (args, extra) => {
      const gate = await withVenue(tenantFrom(extra), args.venueId);
      if (!gate.ok) return errorResult(gate.error);

      const result = await cms(SPLASH_DOCUMENTS_PATH, {
        tenantUserId: gate.tenantUserId,
        venueId: args.venueId,
        action: 'validate',
        type: args.type,
        content: args.content,
        title: args.title,
      });
      if (!result.ok) return errorResult(result.error);

      return jsonResult({
        ...result.data,
        nextStep: 'Summarise the change for the tenant in plain language. Once they explicitly agree, call apply_venue_document with the same text and this confirmToken.',
      });
    },
  );

  addTool<{ venueId: string; type: string; content: string; title?: string; confirmToken: string }>(
    server,
    'apply_venue_document',
    'Publish a venue\'s Terms & Conditions or Privacy Policy. LIVE IMMEDIATELY for guests. Requires the confirmToken from preview_venue_document for this exact text. Publishing creates a new version — the previous text is kept in history, so a mistake is recoverable. Only call this after the tenant has approved the wording.',
    {
      venueId: z.string().describe('The venue id (from list_venues).'),
      type: z.enum(DOCUMENT_TYPES).describe('Which document to publish.'),
      content: z.string().describe('The same text that was passed to preview_venue_document.'),
      title: z.string().optional().describe('The same title that was passed to preview_venue_document.'),
      confirmToken: z.string().describe('The confirmToken returned by preview_venue_document.'),
    },
    async (args, extra) => {
      const gate = await withVenue(tenantFrom(extra), args.venueId);
      if (!gate.ok) return errorResult(gate.error);

      const result = await cms(SPLASH_DOCUMENTS_PATH, {
        tenantUserId: gate.tenantUserId,
        venueId: args.venueId,
        action: 'apply',
        type: args.type,
        content: args.content,
        title: args.title,
        confirmToken: args.confirmToken,
      });

      if (!result.ok) {
        const fresh = typeof result.data.confirmToken === 'string' ? result.data.confirmToken : null;
        return errorResult(
          fresh
            ? `${result.error}\n\nThe correct confirmToken for the text you sent is "${fresh}" — but re-run preview_venue_document and confirm with the tenant rather than just retrying.`
            : result.error,
        );
      }
      return jsonResult(result.data);
    },
  );

  addTool<{ venueId: string; type: string; confirmToken?: string }>(
    server,
    'reset_venue_document',
    'Drop a venue\'s own Terms & Conditions or Privacy Policy so guests see the platform default again. Requires a confirmToken — call once without it to get the token and to show the tenant what they are giving up, then again with it. The venue\'s text is archived rather than deleted, so publishing again restores it.',
    {
      venueId: z.string().describe('The venue id (from list_venues).'),
      type: z.enum(DOCUMENT_TYPES).describe('Which document to reset.'),
      confirmToken: z.string().optional().describe('Omit on the first call to receive the token; pass it back to confirm.'),
    },
    async (args, extra) => {
      const gate = await withVenue(tenantFrom(extra), args.venueId);
      if (!gate.ok) return errorResult(gate.error);

      const result = await cms(SPLASH_DOCUMENTS_PATH, {
        tenantUserId: gate.tenantUserId,
        venueId: args.venueId,
        action: 'reset',
        type: args.type,
        confirmToken: args.confirmToken,
      });

      if (!result.ok) {
        const fresh = typeof result.data.confirmToken === 'string' ? result.data.confirmToken : null;
        return errorResult(
          fresh
            ? `${result.error}\n\nconfirmToken for this reset: "${fresh}". Show the tenant their current text first — it will stop being shown to guests.`
            : result.error,
        );
      }
      return jsonResult(result.data);
    },
  );
}
