import { createZodDto } from 'nestjs-zod';
import { createInvitationSchema } from '@careops/shared';

export class CreateInvitationDto extends createZodDto(createInvitationSchema) {}
