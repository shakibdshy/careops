import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, getSession } from '../auth/auth.guard.js';

/**
 * Placeholder protected route proving the session guard end-to-end. The
 * organization workspace (T4) replaces this with real org context.
 */
@Controller('workspace')
@UseGuards(AuthGuard)
export class WorkspaceController {
  @Get('me')
  me(@Req() request: Request): { user: { id: string; email: string; name: string } } {
    const session = getSession(request);
    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
      },
    };
  }
}
