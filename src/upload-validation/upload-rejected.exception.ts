import { HttpException, HttpStatus } from '@nestjs/common';

export type UploadRejectionReason =
  'too-large' | 'type-mismatch' | 'undecodable' | 'dangerous-content';

const STATUS: Record<UploadRejectionReason, number> = {
  'too-large': HttpStatus.PAYLOAD_TOO_LARGE,
  'type-mismatch': HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  undecodable: HttpStatus.UNPROCESSABLE_ENTITY,
  'dangerous-content': HttpStatus.UNPROCESSABLE_ENTITY,
};

const ERROR_NAME: Record<number, string> = {
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
};

export interface UploadRejectionDetails {
  reason: UploadRejectionReason;
  field: string;
  policy: string;
  claimedType: string;
  detectedType: string;
  size: number;
}

/**
 * A file that failed validation. The message is for the uploader (what IS accepted); the details
 * are for the log and audit trail. Neither ever holds the file's content.
 */
export class UploadRejectedException extends HttpException {
  constructor(
    message: string,
    readonly details: UploadRejectionDetails,
  ) {
    const status = STATUS[details.reason];
    super({ statusCode: status, message, error: ERROR_NAME[status] }, status);
  }
}
