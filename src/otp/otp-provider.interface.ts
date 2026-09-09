export const OTP_PROVIDERS = Symbol('OTP_PROVIDERS');

export interface OtpProvider {
  readonly name: string;
  send(phone: string, code: string): Promise<void>;
}
