import { createHash, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export const BACKOFFICE_SECRET_HEADER = 'x-backoffice-proxy-secret';
export const BACKOFFICE_CLIENT_IP_HEADER = 'x-backoffice-client-ip';
const MIN_SECRET_LENGTH = 32;
const WARN_EVERY_MS = 10 * 60 * 1000;
// Container and uptime health checks call the API directly, without the edge header.
const QUIET_PATHS = new Set(['/health']);

/**
 * The shared secret the back office server proves itself with, or undefined when it isn't set.
 * A short secret fails at boot, before the API takes traffic.
 */
export function resolveBackofficeProxySecret(): string | undefined {
  const secret = process.env.BACKOFFICE_PROXY_SECRET?.trim();
  if (!secret) return undefined;
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BACKOFFICE_PROXY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return secret;
}

/**
 * The header the edge in front of the API sets to the visitor's IP (e.g. cf-connecting-ip behind
 * Cloudflare), or undefined to rely on TRUST_PROXY_HOPS. Only set it while that edge is in front
 * and the server can't be reached around it: otherwise callers could send the header themselves.
 */
export function resolveClientIpHeader(): string | undefined {
  const name = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!name) return undefined;
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      'CLIENT_IP_HEADER must be a single header name, e.g. cf-connecting-ip',
    );
  }
  return name;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

export interface ClientIpOptions {
  backofficeSecret?: string;
  clientIpHeader?: string;
  warn?: (message: string) => void;
  now?: () => number;
}

/**
 * Sets req.ip to the visitor's real address, so login rate limits, sessions and the audit trail
 * see the person rather than a proxy. In order:
 *
 * 1. The back office signs admins in through its own server, which vouches for the admin's IP
 *    with the shared secret. Without a matching secret that header is ignored, so no caller can
 *    choose their own IP. Both headers are removed so nothing downstream reads them.
 * 2. The edge's client-IP header, when CLIENT_IP_HEADER names one. If a request arrives without
 *    it, the edge has probably changed (e.g. Cloudflare removed) while the setting stayed, so
 *    that is logged, at most every 10 minutes.
 * 3. Otherwise Express's own value, from TRUST_PROXY_HOPS.
 */
export function clientIp({
  backofficeSecret,
  clientIpHeader,
  warn = (message) => new Logger('ClientIp').warn(message),
  now = Date.now,
}: ClientIpOptions) {
  const expected = backofficeSecret ? digest(backofficeSecret) : null;
  let lastWarnAt = -Infinity;
  return (req: Request, _res: Response, next: NextFunction) => {
    const sent = req.headers[BACKOFFICE_SECRET_HEADER];
    const vouched = req.headers[BACKOFFICE_CLIENT_IP_HEADER];
    delete req.headers[BACKOFFICE_SECRET_HEADER];
    delete req.headers[BACKOFFICE_CLIENT_IP_HEADER];

    let ip: string | undefined;
    if (
      expected &&
      typeof sent === 'string' &&
      typeof vouched === 'string' &&
      isIP(vouched) &&
      timingSafeEqual(digest(sent), expected)
    ) {
      ip = vouched;
    } else if (clientIpHeader) {
      const raw = req.headers[clientIpHeader];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (isIP(value)) {
        ip = value;
      } else if (
        !QUIET_PATHS.has(req.path) &&
        now() - lastWarnAt >= WARN_EVERY_MS
      ) {
        lastWarnAt = now();
        warn(
          `CLIENT_IP_HEADER is "${clientIpHeader}" but ${req.method} ${req.path} arrived without a valid one, ` +
            `so its IP falls back to ${req.ip}. If the proxy in front of the API changed (e.g. Cloudflare removed), ` +
            'update CLIENT_IP_HEADER or switch to TRUST_PROXY_HOPS.',
        );
      }
    }

    if (ip) {
      // req.ip is a getter on Express's request prototype; an own property takes its place.
      Object.defineProperty(req, 'ip', {
        value: ip,
        configurable: true,
        enumerable: true,
      });
    }
    next();
  };
}
