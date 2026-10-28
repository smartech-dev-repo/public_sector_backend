export const SMS_PROVIDERS_BY_TYPE = Symbol('SMS_PROVIDERS_BY_TYPE');
export const SMS_CHANNELS_BY_TYPE = Symbol('SMS_CHANNELS_BY_TYPE');

export type SmsChannel = 'dnd' | 'generic';

export interface SmsProvider {
  readonly name: string;
  send(phone: string, message: string, channel: SmsChannel): Promise<void>;
}
