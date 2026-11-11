import { Body, Controller, Get, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateInvitationDto, OrganizationCurrent, Invitation } from '@careops/shared';
import { getAuth } from '../auth/auth.instance.js';
import { getFullOrganization, getOrgContext, OrgContextGuard, Roles } from '../auth/org-context.js';

/**
 * Thin surface over BetterAuth's organization plugin (ADR-0004): creation
 * happens automatically at signup (database hook), this controller exposes
 * membership reads and invitation creation under the domain contract.
 */
@Controller('organizations')
@UseGuards(OrgContextGuard)
export class OrganizationsController {
  @Get('current')
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
  async invite(@Req() request: Request, @Body() body: CreateInvitationDto): Promise<Invitation> {
    const headers = new Headers(request.headers as Record<string, string>);
    const org = getOrgContext(request);
    const invitation = await getAuth().api.createInvitation({
      body: { email: body.email, role: body.role, organizationId: org.organizationId },
      headers,
    });
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      organizationId: invitation.organizationId,
    };
  }

  @Get('invitations/:invitationId')
  async invitation(@Req() request: Request, invitationId: string): Promise<Invitation> {
    const headers = new Headers(request.headers as Record<string, string>);
    const invitation = await getAuth().api.getInvitation({
      query: { id: invitationId },
      headers,
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      organizationId: invitation.organizationId,
    };
  }
}
