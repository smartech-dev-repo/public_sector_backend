import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { SmsService } from './sms.service';
import { SmsProvider } from './sms-provider.interface';
import { SmsType } from './sms-type';

function fakeProvider(name: string, send: jest.Mock): SmsProvider {
  return { name, send };
}

describe('SmsService', () => {
  it('routes to the provider and channel configured for the SMS type', async () => {
    const otpSend = jest.fn().mockResolvedValue(undefined);
    const loanSend = jest.fn().mockResolvedValue(undefined);
    const service = new SmsService(
      {
        [SmsType.OTP]: fakeProvider('console', otpSend),
        [SmsType.LOAN_CONFIRMATION]: fakeProvider('termii', loanSend),
        [SmsType.NOTIFICATION]: fakeProvider('console', otpSend),
      },
      {
        [SmsType.OTP]: 'dnd',
        [SmsType.LOAN_CONFIRMATION]: 'generic',
        [SmsType.NOTIFICATION]: 'dnd',
      },
    );

    await service.send({ type: SmsType.LOAN_CONFIRMATION, phone: '+2348000000000', message: 'Reply YES' });

    expect(loanSend).toHaveBeenCalledWith('+2348000000000', 'Reply YES', 'generic');
    expect(otpSend).not.toHaveBeenCalled();
  });

  it('logs the real cause and fails with a 503 the user can act on, without calling any other provider', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const failingSend = jest.fn().mockRejectedValue(new Error('vendor down'));
    const otherSend = jest.fn().mockResolvedValue(undefined);
    const service = new SmsService(
      {
        [SmsType.OTP]: fakeProvider('termii', failingSend),
        [SmsType.LOAN_CONFIRMATION]: fakeProvider('console', otherSend),
        [SmsType.NOTIFICATION]: fakeProvider('console', otherSend),
      },
      {
        [SmsType.OTP]: 'dnd',
        [SmsType.LOAN_CONFIRMATION]: 'dnd',
        [SmsType.NOTIFICATION]: 'dnd',
      },
    );

    const error = await service.send({ type: SmsType.OTP, phone: '+2348000000000', message: '1234' }).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(error.message).toBe("We couldn't send the confirmation code. Please try again shortly");
    expect(error.cause).toEqual(new Error('vendor down'));

    expect(logSpy).toHaveBeenCalledWith('SMS provider "termii" failed for type OTP: vendor down');
    expect(otherSend).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
