/**
 * Deterministic EmailDesignV1 -> email-safe HTML renderer.
 *
 * Output rules: nested tables, inline styles only, 600px centered card,
 * bulletproof buttons, no <script>/<style>. The footer (unsubscribe +
 * optional "Powered by HeidiFi") is ALWAYS rendered — it is not a block and
 * cannot be removed in the editor. The unsubscribe anchor uses the
 * {{unsubscribeUrl}} merge token, which the captive-server dispatcher
 * resolves per recipient; because the token is present, the send-time
 * `ensureUnsubscribeFooter` backstop never double-injects.
 *
 * VENDORED COPY — KEEP IN SYNC with cms/lib/email-blocks/render.ts (source
 * copy — shared golden fixtures guard against drift).
 */
import {
  CONTENT_WIDTH,
  FONT_STACKS,
  type BlockStyles,
  type ButtonBlock,
  type ColumnsBlock,
  type DividerBlock,
  type EmailBlock,
  type EmailDesign,
  type HeaderBlock,
  type ImageBlock,
  type LeafBlock,
  type SocialBlock,
  type SpacerBlock,
  type TextBlock,
} from './schema';
import { escapeHtml, sanitizeTextHtml } from './sanitize';

export interface RenderOptions {
  /** Include the "Powered by HeidiFi" footer segment (preview/plan-dependent). */
  poweredBy?: boolean;
}

const MUTED = '#717171';
const LINE = '#EBEBEB';

const SOCIAL_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  website: 'Website',
};

function pad(styles: BlockStyles): string {
  const { top, right, bottom, left } = styles.padding;
  return `padding:${top}px ${right}px ${bottom}px ${left}px;`;
}

function tdStyle(styles: BlockStyles): string {
  const bg = styles.backgroundColor ? `background-color:${styles.backgroundColor};` : '';
  return `${pad(styles)}${bg}`;
}

function align(styles: BlockStyles, fallback: 'left' | 'center' | 'right' = 'left'): string {
  return styles.align ?? fallback;
}

function renderHeader(block: HeaderBlock, design: EmailDesign): string {
  const { props } = block;
  const parts: string[] = [];
  if (props.logoUrl) {
    const width = props.logoWidth ?? 140;
    parts.push(
      `<img src="${escapeHtml(props.logoUrl)}" alt="${escapeHtml(props.title ?? 'Logo')}" width="${width}" style="display:block;margin:0 auto;max-width:100%;height:auto;border:0;" />`,
    );
  }
  if (props.title) {
    const color = props.titleColor ?? design.settings.textColor;
    parts.push(
      `<h1 style="margin:${props.logoUrl ? '16px' : '0'} 0 0 0;font-size:24px;line-height:32px;font-weight:700;color:${color};">${escapeHtml(props.title)}</h1>`,
    );
  }
  if (props.subtitle) {
    parts.push(
      `<p style="margin:8px 0 0 0;font-size:15px;line-height:22px;color:${MUTED};">${escapeHtml(props.subtitle)}</p>`,
    );
  }
  return `<td align="${align(block.styles, 'center')}" style="${tdStyle(block.styles)}">${parts.join('')}</td>`;
}

function renderText(block: TextBlock, design: EmailDesign): string {
  const fontSize = block.props.fontSize ?? 15;
  const color = block.props.color ?? design.settings.textColor;
  const lineHeight = Math.round(fontSize * 1.5);
  const html = sanitizeTextHtml(block.props.html);
  return `<td align="${align(block.styles)}" style="${tdStyle(block.styles)}font-size:${fontSize}px;line-height:${lineHeight}px;color:${color};">${html}</td>`;
}

function renderImage(block: ImageBlock, contentWidth: number): string {
  const { props } = block;
  const width = Math.min(props.width ?? contentWidth, contentWidth);
  const radius = props.borderRadius ? `border-radius:${props.borderRadius}px;` : '';
  let img = `<img src="${escapeHtml(props.src)}" alt="${escapeHtml(props.alt)}" width="${width}" style="display:block;max-width:100%;height:auto;border:0;${radius}" />`;
  if (props.href) {
    img = `<a href="${escapeHtml(props.href)}" target="_blank" rel="noopener" style="text-decoration:none;">${img}</a>`;
  }
  return `<td align="${align(block.styles, 'center')}" style="${tdStyle(block.styles)}">${img}</td>`;
}

function renderButton(block: ButtonBlock): string {
  const { props } = block;
  const btnWidth = props.fullWidth ? '100%' : 'auto';
  // Table-wrapped anchor: reliable across Outlook and mobile clients.
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${btnWidth}" style="border-collapse:separate;"><tr><td align="center" bgcolor="${props.backgroundColor}" style="border-radius:${props.borderRadius}px;background-color:${props.backgroundColor};"><a href="${escapeHtml(props.href)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 28px;font-size:15px;line-height:22px;font-weight:600;color:${props.color};text-decoration:none;border-radius:${props.borderRadius}px;">${escapeHtml(props.label)}</a></td></tr></table>`;
  const wrap = props.fullWidth
    ? button
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align(block.styles, 'center')}"><tr><td>${button}</td></tr></table>`;
  return `<td align="${align(block.styles, 'center')}" style="${tdStyle(block.styles)}">${wrap}</td>`;
}

function renderDivider(block: DividerBlock): string {
  return `<td style="${tdStyle(block.styles)}"><div style="border-top:${block.props.thickness}px solid ${block.props.color};font-size:0;line-height:0;">&nbsp;</div></td>`;
}

function renderSpacer(block: SpacerBlock): string {
  return `<td style="${tdStyle(block.styles)}"><div style="height:${block.props.height}px;font-size:0;line-height:0;">&nbsp;</div></td>`;
}

function renderSocial(block: SocialBlock, design: EmailDesign): string {
  const links = block.props.links
    .map(
      (link) =>
        `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" style="display:inline-block;margin:0 8px;font-size:13px;line-height:20px;font-weight:600;color:${design.settings.linkColor};text-decoration:none;">${SOCIAL_LABELS[link.network] ?? link.network}</a>`,
    )
    .join('');
  return `<td align="${align(block.styles, 'center')}" style="${tdStyle(block.styles)}">${links}</td>`;
}

const COLUMN_WIDTHS: Record<ColumnsBlock['props']['ratio'], number[]> = {
  '50-50': [50, 50],
  '33-67': [33, 67],
  '67-33': [67, 33],
  '33-33-33': [34, 33, 33],
};

function renderLeaf(block: LeafBlock, design: EmailDesign, columnWidth: number): string {
  switch (block.type) {
    case 'text':
      return renderText(block, design);
    case 'image':
      return renderImage(block, columnWidth);
    case 'button':
      return renderButton(block);
    case 'spacer':
      return renderSpacer(block);
  }
}

function renderColumns(block: ColumnsBlock, design: EmailDesign): string {
  const widths = COLUMN_WIDTHS[block.props.ratio];
  const cells = block.props.columns
    .map((column, i) => {
      const pct = widths[i] ?? Math.floor(100 / block.props.columns.length);
      const innerWidth = Math.floor((CONTENT_WIDTH * pct) / 100);
      const rows = column
        .map((leaf) => `<tr>${renderLeaf(leaf, design, innerWidth)}</tr>`)
        .join('');
      return `<td width="${pct}%" valign="top" style="width:${pct}%;vertical-align:top;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td>`;
    })
    .join('');
  return `<td style="${tdStyle(block.styles)}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table></td>`;
}

function renderBlock(block: EmailBlock, design: EmailDesign): string {
  switch (block.type) {
    case 'header':
      return renderHeader(block, design);
    case 'text':
      return renderText(block, design);
    case 'image':
      return renderImage(block, CONTENT_WIDTH);
    case 'button':
      return renderButton(block);
    case 'divider':
      return renderDivider(block);
    case 'spacer':
      return renderSpacer(block);
    case 'columns':
      return renderColumns(block, design);
    case 'social':
      return renderSocial(block, design);
  }
}

/**
 * The mandatory footer. Markup/copy mirrors lib/email-unsubscribe.js
 * FOOTER_INNER so blocks emails and built-in templates look identical.
 * The powered-by segment carries the <!--hf-pb--> marker so the send-time
 * injector (captive-server) recognizes it and never doubles it up.
 */
function renderFooter(design: EmailDesign, opts: RenderOptions): string {
  const poweredBy = opts.poweredBy !== false;
  const address =
    design.footer.showAddress && design.footer.addressText
      ? `<p style="margin:0 0 6px 0;font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(design.footer.addressText)}</p>`
      : '';
  return `<tr><td style="padding:24px 32px 32px 32px;border-top:1px solid ${LINE};">
${address}<p style="margin:0 0 6px 0;font-size:12px;line-height:18px;color:${MUTED};">You're receiving this because you connected to Wi-Fi at {{venueName}}.</p>
<p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};"><a href="{{unsubscribeUrl}}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a>${poweredBy ? `<!--hf-pb-->&nbsp;·&nbsp; Powered by HeidiFi` : ''}</p>
</td></tr>`;
}

/**
 * Render a validated EmailDesign to a complete email-safe HTML document.
 * Pure and deterministic: same design + options always produce the same
 * string (golden-fixture tested in both repos).
 */
export function renderEmailBlocks(design: EmailDesign, opts: RenderOptions = {}): string {
  const { settings } = design;
  const fontStack = FONT_STACKS[settings.fontFamily] ?? FONT_STACKS.arial;

  const rows = design.blocks.map((block) => `<tr>${renderBlock(block, design)}</tr>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
</head>
<body style="margin:0;padding:0;background-color:${settings.backgroundColor};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${settings.backgroundColor};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="${CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${CONTENT_WIDTH}px;max-width:100%;background-color:${settings.contentBackgroundColor};border-radius:12px;overflow:hidden;font-family:${fontStack};color:${settings.textColor};">
${rows}
${renderFooter(design, opts)}
</table>
</td></tr>
</table>
</body>
</html>`;
}
