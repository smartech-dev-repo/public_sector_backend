import { ConfigService } from '@nestjs/config';
import { TermiiSmsProvider } from './termii-sms.provider';

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: string) => values[key] ?? defaultValue),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) {
        throw new Error(`Config "${key}" not found`);
      }
      return values[key];
    }),
  } as unknown as ConfigService;
}

describe('TermiiSmsProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends with the exact Termii request shape and succeeds on code "ok"', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      statusText: 'OK',
      json: jest.fn().mockResolvedValue({ code: 'ok', message: 'Successfully Sent', message_id: '123' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new TermiiSmsProvider(
      fakeConfig({ TERMII_API_KEY: 'key-1', TERMII_SENDER_ID: 'CompanyName' }),
    );

    await expect(provider.send('2347880234567', 'Hi there', 'dnd')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: 'key-1',
        to: '2347880234567',
        from: 'CompanyName',
        sms: 'Hi there',
        type: 'plain',
        channel: 'dnd',
      }),
    });
  });

  it('uses TERMII_BASE_URL when configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      statusText: 'OK',
      json: jest.fn().mockResolvedValue({ code: 'ok' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new TermiiSmsProvider(
      fakeConfig({
        TERMII_API_KEY: 'key-1',
        TERMII_SENDER_ID: 'CompanyName',
        TERMII_BASE_URL: 'https://api.custom.termii.com',
      }),
    );

    await provider.send('2347880234567', 'Hi', 'generic');

    expect(fetchMock).toHaveBeenCalledWith('https://api.custom.termii.com/api/sms/send', expect.anything());
  });

  it("throws with Termii's message when the response code is not \"ok\"", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      statusText: 'OK',
      json: jest.fn().mockResolvedValue({ code: 'error', message: 'Insufficient balance' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new TermiiSmsProvider(
      fakeConfig({ TERMII_API_KEY: 'key-1', TERMII_SENDER_ID: 'CompanyName' }),
    );

    await expect(provider.send('2347880234567', 'Hi', 'dnd')).rejects.toThrow(
      'Termii send failed: Insufficient balance',
    );
  });

  it('throws on a non-2xx HTTP status, falling back to statusText', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      statusText: 'Service Unavailable',
      json: jest.fn().mockResolvedValue({}),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new TermiiSmsProvider(
      fakeConfig({ TERMII_API_KEY: 'key-1', TERMII_SENDER_ID: 'CompanyName' }),
    );

    await expect(provider.send('2347880234567', 'Hi', 'dnd')).rejects.toThrow(
      'Termii send failed: Service Unavailable',
    );
  });

  it('throws when TERMII_API_KEY is not configured', async () => {
    const provider = new TermiiSmsProvider(fakeConfig({ TERMII_SENDER_ID: 'CompanyName' }));

    await expect(provider.send('2347880234567', 'Hi', 'dnd')).rejects.toThrow('Config "TERMII_API_KEY" not found');
  });

  it('throws when TERMII_SENDER_ID is not configured', async () => {
    const provider = new TermiiSmsProvider(fakeConfig({ TERMII_API_KEY: 'key-1' }));

    await expect(provider.send('2347880234567', 'Hi', 'dnd')).rejects.toThrow('Config "TERMII_SENDER_ID" not found');
  });
});
