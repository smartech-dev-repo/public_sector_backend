import { Request } from 'express';
import { DeviceInfo, deviceInfoFromHeaders } from '../devices/device-info.util';

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

/** Sign-in metadata plus the phone, from the X-Device-* headers. Kept apart from audit metadata. */
export interface SignInMetadata extends RequestMetadata {
  device?: DeviceInfo;
}

export function getSignInMetadata(req: Request): SignInMetadata {
  return { ...getRequestMetadata(req), device: deviceInfoFromHeaders(req.headers) };
}
