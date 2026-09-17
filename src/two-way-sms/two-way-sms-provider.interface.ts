export const TWO_WAY_SMS_PROVIDER = Symbol('TWO_WAY_SMS_PROVIDER');

export interface TwoWaySmsProvider {
  send(phone: string, message: string): Promise<void>;
}
