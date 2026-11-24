/** How long a third-party call may take before it is abandoned. */
export const OUTBOUND_TIMEOUT_MS = 15_000;

export interface OutboundFetchInit extends Omit<
  RequestInit,
  'redirect' | 'signal'
> {
  timeoutMs?: number;
}

/**
 * fetch() for server-to-server calls to a fixed third party (KYC, SMS, push).
 *
 * Redirects are never followed: several of these calls carry secrets in headers or the body,
 * and a redirect would replay them to wherever the 3xx points. A redirect is treated as a
 * failure instead. The call is also bounded by a timeout, so a hung provider can't tie up
 * the request that triggered it.
 */
export async function outboundFetch(
  url: string,
  init: OutboundFetchInit = {},
): Promise<Response> {
  const { timeoutMs = OUTBOUND_TIMEOUT_MS, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    // Drain the body so the connection is released.
    await res.body?.cancel().catch(() => undefined);
    throw new Error(
      `${new URL(url).host} answered with a redirect (${res.status}); not followed`,
    );
  }
  return res;
}
