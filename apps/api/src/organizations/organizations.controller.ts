import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import {
  createInvitationSchema,
  type CreateInvitationDto as CreateInvitationPayload,
  type Invitation,
  type OrganizationCurrent,
} from '@careops/shared';
import { getAuth } from '../auth/auth.instance.js';
import {
  getFullOrganization,
  getOrgContext,
  headersFromRequest,
  OrgContextGuard,
  Roles,
} from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ErrorResponseDto } from '../common/error-response.dto.js';
import { CreateInvitationDto as CreateInvitationDtoClass } from './organizations.dto.js';
import type { FullOrganization } from '../auth/org-context.js';

function toInvitationDto(invitation: {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationId: string;
}): Invitation {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role as Invitation['role'],
    status: invitation.status,
    organizationId: invitation.organizationId,
  };
}

/**
 * Thin surface over BetterAuth's organization plugin (ADR-0004): creation
 * happens automatically at signup (database hook), this controller exposes
 * membership reads and invitation creation under the domain contract.
 */
@ApiTags('Organizations')
@ApiBearerAuth('session-cookie')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Not authenticated' })
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: 'Requires the admin or owner role (invitation creation)',
})
@Controller('organizations')
@UseGuards(OrgContextGuard)
export class OrganizationsController {
  @Get('current')
  @ApiOperation({
    summary: 'The active organization with its members',
    description: 'Members carry their roles — the RBAC surface of the tenant boundary.',
  })
  @ApiOkResponse({ description: 'Organization with member roles' })
  current(@Req() request: Request): OrganizationCurrent {
    const fullOrg = getFullOrganization(request);
    return {
      id: fullOrg.id,
      name: fullOrg.name,
      slug: fullOrg.slug,
      members: fullOrg.members.map((member) => ({
        id: member.id,
        userId: member.userId,
        email: member.user.email,
        name: member.user.name,
        // BetterAuth types role as string; the plugin only produces the three.
        role: member.role as OrganizationCurrent['members'][number]['role'],
      })),
    };
  }

  @Post('invitations')
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Invite a user by email (admin/owner)',
    description:
      'Creates a pending invitation; the invitee accepts via POST /api/auth/organization/accept-invitation.',
  })
  @ApiBody({ type: CreateInvitationDtoClass })
  @ApiResponse({ status: 201, description: 'Pending invitation created' })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — field-level errors',
  })
  async invite(
    @Req() request: Request,
    @Body(new ZodValidationPipe(createInvitationSchema)) body: CreateInvitationPayload,
  ): Promise<Invitation> {
    const org = getOrgContext(request);
    const invitation = await getAuth().api.createInvitation({
      body: { email: body.email, role: body.role, organizationId: org.organizationId },
      headers: headersFromRequest(request),
    });
    return toInvitationDto(invitation);
  }

  @Get('invitations/:invitationId')
  @ApiOperation({ summary: 'Look up an invitation (for the accept flow)' })
  @ApiOkResponse({ description: 'The invitation' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Invitation not found' })
  async invitation(
    @Req() request: Request,
    @Param('invitationId') invitationId: string,
  ): Promise<Invitation> {
    const invitation = await getAuth().api.getInvitation({
      query: { id: invitationId },
      headers: headersFromRequest(request),
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    return toInvitationDto(invitation);
  }
}

export type { FullOrganization };
