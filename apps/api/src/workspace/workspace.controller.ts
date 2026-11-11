import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { WorkspaceMe } from '@careops/shared';
import { ErrorResponseDto } from '../common/error-response.dto.js';
import { getOrgContext, getSession, OrgContextGuard, Roles } from '../auth/org-context.js';

/**
 * Placeholder workspace routes proving session + org context + RBAC
 * end-to-end. T5's Patients slice replaces the placeholder surface; the
 * guards stay.
 */
@ApiTags('Workspace')
@ApiBearerAuth('session-cookie')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Not authenticated' })
@Controller('workspace')
@UseGuards(OrgContextGuard)
export class WorkspaceController {
  @Get('me')
  @ApiOperation({
    summary: 'Who am I acting as',
    description:
      'The verified session user plus the active Organization and the caller’s role in it.',
  })
  @ApiOkResponse({ description: 'Session user with organization context' })
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
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'RBAC probe (admin/owner only)',
    description:
      'Returns ok only for admin/owner members — used to prove role enforcement end-to-end.',
  })
  @ApiOkResponse({ description: 'Caller has an elevated role' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'Requires the admin or owner role',
  })
  adminProbe(): { ok: boolean } {
    return { ok: true };
  }
}
