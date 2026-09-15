import { Request } from 'express';

export interface RequestMetadata {
  userAgent?: string;
  ip?: string;
}

export function getRequestMetadata(req: Request): RequestMetadata {
  const userAgent = req.headers['user-agent'];
  return {
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
    ip: req.ip,
  };
}
