/**
 * Tenant branding read tool — the AI uses this to design on-brand emails
 * (colors, logo, tone of voice). Written by the CMS Branding settings page
 * (CaptivePortal_TenantBranding/{tenantUserId}).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../firebase';
import { NO_TENANT, errorResult, jsonResult, tenantFrom, type ToolExtra } from '../shared';

const COLLECTION = 'CaptivePortal_TenantBranding';

export function registerBrandingTools(server: McpServer): void {
  server.tool(
    'get_branding',
    'Get the tenant’s brand profile: business name, tagline, logo URL, brand colors (primary/secondary/accent), font, tone of voice, website and social links. Use it in every email design and to match copy tone. Returns branding: null when the tenant has not set it up yet.',
    async (extra: ToolExtra) => {
      const tenantUserId = tenantFrom(extra);
      if (!tenantUserId) return errorResult(NO_TENANT);

      const snap = await db.collection(COLLECTION).doc(tenantUserId).get();
      if (!snap.exists) {
        return jsonResult({
          branding: null,
          note: 'No branding saved yet — suggest the user sets it up under Branding in their dashboard; use tasteful neutral colors meanwhile.',
        });
      }
      const d = snap.data() as Record<string, unknown>;
      return jsonResult({
        branding: {
          businessName: d.businessName ?? '',
          tagline: d.tagline ?? '',
          logoUrl: d.logoUrl ?? '',
          logoDarkUrl: d.logoDarkUrl ?? '',
          primaryColor: d.primaryColor ?? '#1c2b4a',
          secondaryColor: d.secondaryColor ?? '#f4f5f7',
          accentColor: d.accentColor ?? '#1c2b4a',
          fontFamily: d.fontFamily ?? 'arial',
          tone: d.tone ?? 'friendly',
          website: d.website ?? '',
          socials: d.socials ?? {},
        },
      });
    },
  );
}
