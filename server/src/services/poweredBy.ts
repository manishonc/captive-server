/**
 * "Powered by HeidiFi" email footer — injected at send time unless the
 * tenant's plan carries the hidePoweredBy flag.
 *
 * Idempotent via the <!--hf-pb--> marker: the CMS block renderer emits the
 * same marker in its preview footer, so emails designed with blocks are
 * never double-branded, and re-running injection is a no-op.
 */

const MARKER = '<!--hf-pb-->';

const FOOTER_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:transparent;">
  <tr>
    <td align="center" style="padding:8px 12px 16px 12px;">
      <p style="margin:0;font-size:11px;line-height:16px;color:#9b9b9b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${MARKER}Powered by HeidiFi</p>
    </td>
  </tr>
</table>`;

export function hasPoweredBy(html: string): boolean {
  return html.includes(MARKER) || /powered by heidifi/i.test(html);
}

/** Append the powered-by footer unless already present. */
export function injectPoweredBy(html: string): string {
  const safe = typeof html === 'string' ? html : '';
  if (hasPoweredBy(safe)) return safe;
  const idx = safe.toLowerCase().lastIndexOf('</body>');
  if (idx !== -1) return safe.slice(0, idx) + FOOTER_HTML + '\n' + safe.slice(idx);
  return safe + FOOTER_HTML;
}
