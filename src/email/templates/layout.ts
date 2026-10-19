const PRIMARY_GREEN = '#2B6830';
const SECONDARY_GREEN = '#7AC142';
const OLIVE_GOLD = '#96874A';
const BODY_TEXT_COLOR = '#2D2D2D';
const PAGE_BACKGROUND = '#F4F6F4';
const CARD_BACKGROUND = '#FFFFFF';
const RC_NUMBER = 'RC: 903524';

function logoUrl(): string {
  return (
    process.env.EMAIL_LOGO_URL ??
    'https://res.cloudinary.com/dwfedg8uv/image/upload/f_auto,q_auto:best/moneyfield-logo_vcfhhn'
  );
}

function companyName(): string {
  return process.env.EMAIL_FROM_NAME ?? 'Moneyfield Microfinance Bank Limited';
}

function supportEmail(): string {
  return process.env.SUPPORT_EMAIL ?? 'support@moneyfieldmfb.com';
}

export function highlightBox(value: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding: 16px 0;"><div style="display: inline-block; background-color: #EAF5EA; border: 2px solid ${PRIMARY_GREEN}; border-radius: 6px; padding: 12px 24px; font-family: monospace; font-size: 22px; font-weight: 700; letter-spacing: 2px; color: ${PRIMARY_GREEN};">${value}</div></td></tr></table>`;
}

export function wrapEmailLayout(params: { headline: string; bodyHtml: string }): string {
  return `<!doctype html>
<html>
  <body style="margin: 0; padding: 0; background-color: ${PAGE_BACKGROUND}; font-family: Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${PAGE_BACKGROUND};">
      <tr>
        <td align="center" style="padding: 24px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background-color: ${CARD_BACKGROUND};">
            <tr>
              <td align="center" style="background-color: ${CARD_BACKGROUND}; padding: 24px; border-bottom: 2px solid ${SECONDARY_GREEN};">
                <img src="${logoUrl()}" alt="${companyName()}" style="max-width: 240px; height: auto;" />
              </td>
            </tr>
            <tr>
              <td style="background-color: ${CARD_BACKGROUND}; padding: 32px;">
                <h1 style="margin: 0 0 16px; color: ${PRIMARY_GREEN}; font-size: 20px; font-weight: 600;">${params.headline}</h1>
                <div style="color: ${BODY_TEXT_COLOR}; font-size: 15px; line-height: 1.6;">${params.bodyHtml}</div>
              </td>
            </tr>
            <tr>
              <td align="center" style="background-color: ${PAGE_BACKGROUND}; padding: 24px; font-size: 12px; color: #6B6B6B;">
                <div style="color: ${OLIVE_GOLD}; font-weight: 600;">${companyName()}</div>
                <div>${RC_NUMBER}</div>
                <div>Need help? Contact ${supportEmail()}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function wrapEmailLayoutText(params: { headline: string; bodyText: string }): string {
  return `${params.headline}\n\n${params.bodyText}\n\n—\n${companyName()}\n${RC_NUMBER}\nNeed help? Contact ${supportEmail()}`;
}
