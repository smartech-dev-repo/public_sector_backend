import { UploadRejectionReason } from '../upload-rejected.exception';

/** Thrown by an inspector; ValidateUpload turns it into an UploadRejectedException with the request's details. */
export class InspectionFailure extends Error {
  constructor(
    readonly reason: UploadRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'InspectionFailure';
  }
}
