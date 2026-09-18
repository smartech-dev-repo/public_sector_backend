import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<{ id?: string }>();
    const response = httpContext.getResponse<{ setHeader: (name: string, value: string) => void }>();

    if (request.id) {
      response.setHeader('X-Request-Id', request.id);
    }

    return next.handle();
  }
}
