import { ConfigService } from '@nestjs/config';
import { devCodeEcho } from './dev-code-echo.util';

describe('devCodeEcho', () => {
  it('returns the code when the flag is the string "true"', () => {
    const configService = { get: jest.fn().mockReturnValue('true') } as unknown as ConfigService;
    expect(devCodeEcho(configService, '123456')).toBe('123456');
  });

  it('returns undefined when the flag is unset', () => {
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    expect(devCodeEcho(configService, '123456')).toBeUndefined();
  });

  it('returns undefined when the flag is any other value', () => {
    const configService = { get: jest.fn().mockReturnValue('false') } as unknown as ConfigService;
    expect(devCodeEcho(configService, '123456')).toBeUndefined();
  });

  it('returns undefined when configService itself is undefined', () => {
    expect(devCodeEcho(undefined, '123456')).toBeUndefined();
  });
});
