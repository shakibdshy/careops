import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { getAuth, type CareOpsSession } from './auth.instance.js';

export const SESSION_REQUEST_KEY = 'careopsSession';

type SessionRequest = Request & { [SESSION_REQUEST_KEY]?: CareOpsSession };

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const headers = new Headers(request.headers as Record<string, string>);
    const session = await getAuth().api.getSession({ headers });
    if (!session) {
      throw new UnauthorizedException('Authentication required');
    }
    Object.defineProperty(request, SESSION_REQUEST_KEY, {
      value: session,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return true;
  }
}

/** The verified session attached by AuthGuard. Only valid inside guarded routes. */
export function getSession(request: Request): CareOpsSession {
  const session = (request as SessionRequest)[SESSION_REQUEST_KEY];
  if (!session) {
    throw new UnauthorizedException('Authentication required');
  }
  return session;
}
