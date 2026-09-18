import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { RequestIdInterceptor } from './request-id.interceptor';

function buildContext(request: { id?: string }, response: { setHeader: jest.Mock }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('RequestIdInterceptor', () => {
  const interceptor = new RequestIdInterceptor();
  const next: CallHandler = { handle: () => of('result') };

  it("sets the X-Request-Id response header from the request's id", (done) => {
    const setHeader = jest.fn();
    const context = buildContext({ id: 'req-123' }, { setHeader });

    interceptor.intercept(context, next).subscribe(() => {
      expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      done();
    });
  });

  it('does not set a header when the request has no id', (done) => {
    const setHeader = jest.fn();
    const context = buildContext({}, { setHeader });

    interceptor.intercept(context, next).subscribe(() => {
      expect(setHeader).not.toHaveBeenCalled();
      done();
    });
  });
});
