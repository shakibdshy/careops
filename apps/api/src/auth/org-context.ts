import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { getAuth, type CareOpsSession } from './auth.instance.js';

export const SESSION_REQUEST_KEY = 'careopsSession';
export const ORG_CONTEXT_REQUEST_KEY = 'careopsOrgContext';
export const FULL_ORG_REQUEST_KEY = 'careopsFullOrg';

export const ROLE_KEY = 'careopsRequiredRoles';

/** Roles a route requires; the OrgContextGuard checks the active member's role. */
export function Roles(
  ...roles: Array<'owner' | 'admin' | 'member'>
): MethodDecorator & ClassDecorator {
  return SetMetadata(ROLE_KEY, roles);
}

export interface OrgContext {
  organizationId: string;
  organizationName: string;
  role: 'owner' | 'admin' | 'member';
}

/** BetterAuth's full organization record, as resolved by OrgContextGuard. */
export interface FullOrganization {
  id: string;
  name: string;
  slug: string;
  members: Array<{
    id: string;
    userId: string;
    role: string;
    user: { email: string; name: string };
  }>;
}

type SessionRequest = Request & {
  [SESSION_REQUEST_KEY]?: CareOpsSession;
  [ORG_CONTEXT_REQUEST_KEY]?: OrgContext;
  [FULL_ORG_REQUEST_KEY]?: FullOrganization;
};

/**
 * Session + org context in one guard. Org identity always comes from the
 * verified session's active organization — never from the request (ADR-0004
 * consequences, ADR-0006). Routes that need role checks add @Roles(...)
 * and this guard enforces them.
 */
@Injectable()
export class OrgContextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

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

    // Active organization from the session; a user who never chose one (e.g.
    // right after signup) falls back to their first membership.
    let activeOrgId = session.session.activeOrganizationId;
    if (!activeOrgId) {
      const orgs = await getAuth().api.listOrganizations({ headers });
      activeOrgId = orgs[0]?.id;
    }
    if (!activeOrgId) {
      throw new UnauthorizedException('No active organization');
    }
    const fullOrg = (await getAuth().api.getFullOrganization({
      headers,
      query: { organizationId: activeOrgId },
    })) as FullOrganization | null;
    if (!fullOrg) {
      throw new UnauthorizedException('No active organization');
    }
    const me = fullOrg.members.find((member) => member.userId === session.user.id);
    if (!me) {
      throw new UnauthorizedException('Not a member of the active organization');
    }
    const orgContext: OrgContext = {
      organizationId: fullOrg.id,
      organizationName: fullOrg.name,
      // BetterAuth types member.role as string; BetterAuth's organization
      // plugin only produces owner/admin/member.
      role: me.role as OrgContext['role'],
    };
    Object.defineProperty(request, ORG_CONTEXT_REQUEST_KEY, {
      value: orgContext,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(request, FULL_ORG_REQUEST_KEY, {
      value: fullOrg,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    const requiredRoles = this.reflector.getAllAndOverride<Array<'owner' | 'admin' | 'member'>>(
      ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredRoles && !requiredRoles.includes(orgContext.role)) {
      throw new ForbiddenException(
        `Requires role: ${requiredRoles.join(' or ')} (you are ${orgContext.role})`,
      );
    }
    return true;
  }
}

/** The verified org context attached by OrgContextGuard. Guarded routes only. */
export function getOrgContext(request: Request): OrgContext {
  const org = (request as SessionRequest)[ORG_CONTEXT_REQUEST_KEY];
  if (!org) {
    throw new UnauthorizedException('Organization context missing');
  }
  return org;
}

/** The verified session attached by OrgContextGuard. Guarded routes only. */
export function getSession(request: Request): CareOpsSession {
  const session = (request as SessionRequest)[SESSION_REQUEST_KEY];
  if (!session) {
    throw new UnauthorizedException('Authentication required');
  }
  return session;
}

/** The full organization attached by OrgContextGuard. Guarded routes only. */
export function getFullOrganization(request: Request): FullOrganization {
  const fullOrg = (request as SessionRequest)[FULL_ORG_REQUEST_KEY];
  if (!fullOrg) {
    throw new UnauthorizedException('Organization context missing');
  }
  return fullOrg;
}
