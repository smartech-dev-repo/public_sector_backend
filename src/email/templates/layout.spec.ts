import { wrapEmailLayout, wrapEmailLayoutText, highlightBox } from './layout';

describe('highlightBox', () => {
  it('wraps the value in a bordered box', () => {
    const html = highlightBox('123456');
    expect(html).toContain('123456');
    expect(html).toContain('#2B6830');
  });
});

describe('wrapEmailLayout', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('includes the headline, body, logo, and footer', () => {
    const html = wrapEmailLayout({ headline: 'Test Headline', bodyHtml: '<p>Test body</p>' });
    expect(html).toContain('Test Headline');
    expect(html).toContain('Test body');
    expect(html).toContain('RC: 903524');
    expect(html).toContain('moneyfield-logo_vcfhhn');
  });

  it('uses EMAIL_LOGO_URL from the environment when set', () => {
    process.env.EMAIL_LOGO_URL = 'https://example.com/custom-logo.png';
    const html = wrapEmailLayout({ headline: 'H', bodyHtml: '<p>B</p>' });
    expect(html).toContain('https://example.com/custom-logo.png');
  });

  it('uses SUPPORT_EMAIL from the environment when set', () => {
    process.env.SUPPORT_EMAIL = 'help@example.com';
    const html = wrapEmailLayout({ headline: 'H', bodyHtml: '<p>B</p>' });
    expect(html).toContain('help@example.com');
  });

  it('falls back to the default support email when unset', () => {
    delete process.env.SUPPORT_EMAIL;
    const html = wrapEmailLayout({ headline: 'H', bodyHtml: '<p>B</p>' });
    expect(html).toContain('support@moneyfieldmfb.com');
  });
});

describe('wrapEmailLayoutText', () => {
  it('includes the headline, body, and footer with no markup', () => {
    const text = wrapEmailLayoutText({ headline: 'Test Headline', bodyText: 'Test body' });
    expect(text).toContain('Test Headline');
    expect(text).toContain('Test body');
    expect(text).toContain('RC: 903524');
    expect(text).not.toContain('<');
  });
});
