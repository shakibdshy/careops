import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkspaceMe } from '@careops/shared';
import { getOrgContext, getSession, OrgContextGuard, Roles } from '../auth/org-context.js';

/**
 * Placeholder workspace routes proving session + org context + RBAC
 * end-to-end. T5's Patients slice replaces the placeholder surface; the
 * guards stay.
 */
@Controller('workspace')
@UseGuards(OrgContextGuard)
export class WorkspaceController {
  @Get('me')
  me(@Req() request: Request): WorkspaceMe {
    const session = getSession(request);
    const org = getOrgContext(request);
    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
      },
      organization: {
        id: org.organizationId,
        name: org.organizationName,
        role: org.role,
      },
    };
  }

  @Get('admin-probe')
  @Roles('admin', 'owner')
  adminProbe(): { ok: boolean } {
    return { ok: true };
  }
}
