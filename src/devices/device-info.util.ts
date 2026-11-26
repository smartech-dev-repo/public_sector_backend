import { Request } from 'express';

/**
 * What the mobile apps send about the phone, as request headers on sign-in (and any call):
 *
 *   X-Device-Id          required for binding: a stable per-install id (Android ID, iOS
 *                        identifierForVendor, or one the app generates and keeps in secure storage)
 *   X-Device-Name        e.g. "Amina's Galaxy"
 *   X-Device-Brand       e.g. "Samsung"
 *   X-Device-Model       e.g. "SM-A155F"
 *   X-Device-Platform    android | ios
 *   X-Device-Os-Version  e.g. "14"
 *   X-Device-Imei        only where the OS allows it (not iOS; not Android 10+ for normal apps)
 *   X-App-Version        e.g. "1.4.0"
 *   X-Push-Token         the FCM registration token, for push notifications
 */
export interface DeviceInfo {
  fingerprint: string;
  imei?: string;
  deviceName?: string;
  brand?: string;
  model?: string;
  platform?: string;
  osVersion?: string;
  appVersion?: string;
  pushToken?: string;
}

const clean = (value: unknown, max: number): string | undefined => {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string') return undefined;
  // Printable characters only, trimmed and capped: these are shown in the back office and emails.
  const trimmed = text
    .replace(/[^\x20-\x7E -￿]/g, '')
    .trim()
    .slice(0, max);
  return trimmed || undefined;
};

export function deviceInfoFromHeaders(
  headers: Request['headers'],
): DeviceInfo | undefined {
  const fingerprint = clean(headers['x-device-id'], 200);
  if (!fingerprint) return undefined;
  const platform = clean(headers['x-device-platform'], 20)?.toLowerCase();
  return {
    fingerprint,
    imei: clean(headers['x-device-imei'], 40),
    deviceName: clean(headers['x-device-name'], 120),
    brand: clean(headers['x-device-brand'], 60),
    model: clean(headers['x-device-model'], 80),
    platform,
    osVersion: clean(headers['x-device-os-version'], 30),
    appVersion: clean(headers['x-app-version'], 30),
    pushToken: clean(headers['x-push-token'], 4096),
  };
}

/** "Samsung SM-A155F (Amina's Galaxy)", or whatever parts are known. */
export function describeDevice(device: {
  deviceName?: string | null;
  brand?: string | null;
  model?: string | null;
  platform?: string | null;
}): string {
  const hardware = [device.brand, device.model].filter(Boolean).join(' ');
  const parts = [hardware || device.platform || 'Unknown device'];
  if (device.deviceName && device.deviceName !== hardware)
    parts.push(`(${device.deviceName})`);
  return parts.join(' ');
}
