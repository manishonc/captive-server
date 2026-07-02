/**
 * EmailDesignV1 — the block-based email design schema.
 *
 * VENDORED COPY — KEEP IN SYNC with cms/lib/email-blocks/schema.ts.
 * Identical input must validate identically in both repos; the shared golden
 * fixture (tests/fixtures/email-blocks/basic.json in each repo) guards this.
 * Bump `version` for breaking changes so drift fails loudly.
 */
import { z } from 'zod';

export const EMAIL_DESIGN_VERSION = 1;
export const MAX_BLOCKS = 60;
export const CONTENT_WIDTH = 600;

/** Email-safe font stacks. Keys are stored; renderers map to full stacks. */
export const FONT_STACKS: Record<string, string> = {
  arial: 'Arial, Helvetica, sans-serif',
  helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  verdana: 'Verdana, Geneva, sans-serif',
  trebuchet: "'Trebuchet MS', Tahoma, sans-serif",
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex color');

// Merge tokens like {{unsubscribeUrl}} must survive URL validation, so hrefs
// are either an https/mailto URL or a known token.
const MERGE_TOKEN_HREF = /^\{\{\s*(unsubscribeUrl|ratingUrl)\s*\}\}$/;
const href = z
  .string()
  .max(500)
  .refine(
    (value) => {
      if (MERGE_TOKEN_HREF.test(value)) return true;
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'mailto:';
      } catch {
        return false;
      }
    },
    { message: 'href must be https, mailto, or a merge token' },
  );

const imageSrc = z
  .string()
  .max(500)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'image src must be an https URL' },
  );

const padding = z.object({
  top: z.number().int().min(0).max(120),
  right: z.number().int().min(0).max(120),
  bottom: z.number().int().min(0).max(120),
  left: z.number().int().min(0).max(120),
});

const blockStyles = z.object({
  padding,
  backgroundColor: hexColor.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});

const blockBase = {
  id: z.string().min(1).max(64),
  styles: blockStyles,
};

export const headerBlock = z.object({
  ...blockBase,
  type: z.literal('header'),
  props: z.object({
    logoUrl: imageSrc.optional(),
    logoWidth: z.number().int().min(24).max(CONTENT_WIDTH).optional(),
    title: z.string().max(200).optional(),
    subtitle: z.string().max(300).optional(),
    titleColor: hexColor.optional(),
  }),
});

export const textBlock = z.object({
  ...blockBase,
  type: z.literal('text'),
  // Sanitized on write via sanitize.ts — the schema only bounds size.
  props: z.object({
    html: z.string().max(20000),
    fontSize: z.number().int().min(10).max(48).optional(),
    color: hexColor.optional(),
  }),
});

export const imageBlock = z.object({
  ...blockBase,
  type: z.literal('image'),
  props: z.object({
    src: imageSrc,
    alt: z.string().max(200),
    href: href.optional(),
    width: z.number().int().min(24).max(CONTENT_WIDTH).optional(),
    borderRadius: z.number().int().min(0).max(48).optional(),
  }),
});

export const buttonBlock = z.object({
  ...blockBase,
  type: z.literal('button'),
  props: z.object({
    label: z.string().min(1).max(120),
    href,
    backgroundColor: hexColor,
    color: hexColor,
    borderRadius: z.number().int().min(0).max(40),
    fullWidth: z.boolean().optional(),
  }),
});

export const dividerBlock = z.object({
  ...blockBase,
  type: z.literal('divider'),
  props: z.object({
    color: hexColor,
    thickness: z.number().int().min(1).max(8),
  }),
});

export const spacerBlock = z.object({
  ...blockBase,
  type: z.literal('spacer'),
  props: z.object({
    height: z.number().int().min(4).max(160),
  }),
});

export const socialBlock = z.object({
  ...blockBase,
  type: z.literal('social'),
  props: z.object({
    links: z
      .array(
        z.object({
          network: z.enum(['instagram', 'facebook', 'x', 'linkedin', 'tiktok', 'website']),
          url: href,
        }),
      )
      .min(1)
      .max(6),
  }),
});

/** Blocks allowed inside a column (no nested columns). */
const leafBlock = z.discriminatedUnion('type', [
  textBlock,
  imageBlock,
  buttonBlock,
  spacerBlock,
]);

export const columnsBlock = z.object({
  ...blockBase,
  type: z.literal('columns'),
  props: z.object({
    ratio: z.enum(['50-50', '33-67', '67-33', '33-33-33']),
    columns: z.array(z.array(leafBlock).max(8)).min(2).max(3),
  }),
});

export const emailBlock = z.discriminatedUnion('type', [
  headerBlock,
  textBlock,
  imageBlock,
  buttonBlock,
  dividerBlock,
  spacerBlock,
  columnsBlock,
  socialBlock,
]);

export const emailDesignSchema = z
  .object({
    version: z.literal(EMAIL_DESIGN_VERSION),
    settings: z.object({
      backgroundColor: hexColor,
      contentBackgroundColor: hexColor,
      contentWidth: z.literal(CONTENT_WIDTH),
      fontFamily: z.enum(Object.keys(FONT_STACKS) as [string, ...string[]]),
      textColor: hexColor,
      linkColor: hexColor,
    }),
    blocks: z.array(emailBlock).max(MAX_BLOCKS),
    footer: z.object({
      showAddress: z.boolean().optional(),
      addressText: z.string().max(300).optional(),
    }),
  })
  .superRefine((design, ctx) => {
    // Column ratio must match column count.
    design.blocks.forEach((block, index) => {
      if (block.type !== 'columns') return;
      const expected = block.props.ratio === '33-33-33' ? 3 : 2;
      if (block.props.columns.length !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', index, 'props', 'columns'],
          message: `ratio ${block.props.ratio} requires exactly ${expected} columns`,
        });
      }
    });
  });

export type EmailDesign = z.infer<typeof emailDesignSchema>;
export type EmailBlock = z.infer<typeof emailBlock>;
export type LeafBlock = z.infer<typeof leafBlock>;
export type HeaderBlock = z.infer<typeof headerBlock>;
export type TextBlock = z.infer<typeof textBlock>;
export type ImageBlock = z.infer<typeof imageBlock>;
export type ButtonBlock = z.infer<typeof buttonBlock>;
export type DividerBlock = z.infer<typeof dividerBlock>;
export type SpacerBlock = z.infer<typeof spacerBlock>;
export type ColumnsBlock = z.infer<typeof columnsBlock>;
export type SocialBlock = z.infer<typeof socialBlock>;
export type BlockStyles = z.infer<typeof blockStyles>;

export type ValidationResult =
  | { ok: true; design: EmailDesign }
  | { ok: false; error: string; path?: string };

/**
 * Cheap structural check: is this designJson an EmailDesignV1 (vs legacy
 * Unlayer JSON)?
 */
export function isEmailDesignV1(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { version?: unknown }).version === EMAIL_DESIGN_VERSION &&
    Array.isArray((value as { blocks?: unknown }).blocks)
  );
}

/**
 * Validate an unknown value as an EmailDesign. Returns a machine-readable
 * result instead of throwing.
 */
export function validateEmailDesign(value: unknown): ValidationResult {
  const parsed = emailDesignSchema.safeParse(value);
  if (parsed.success) return { ok: true, design: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: issue ? issue.message : 'Invalid email design',
    path: issue ? issue.path.join('.') : undefined,
  };
}
