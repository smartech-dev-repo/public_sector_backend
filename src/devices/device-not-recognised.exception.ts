import { ForbiddenException } from '@nestjs/common';
import { DEVICE_NOT_RECOGNISED_MESSAGE } from './device-messages';

/**
 * 403 with a code the apps can branch on, and a short-lived token that lets the refused
 * device file a release request without signing in (POST /auth/devices/release-request).
 */
export class DeviceNotRecognisedException extends ForbiddenException {
  constructor(releaseToken: string, linkedDevice: string) {
    super({
      statusCode: 403,
      code: 'DEVICE_NOT_RECOGNISED',
      message: DEVICE_NOT_RECOGNISED_MESSAGE,
      linkedDevice,
      releaseToken,
      error: 'Forbidden',
    });
  }
}
