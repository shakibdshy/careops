import { createZodDto } from 'nestjs-zod';
import { auditEntriesPageSchema, auditEntrySchema } from '@careops/shared';

export class AuditEntryDto extends createZodDto(auditEntrySchema) {}
export class AuditEntriesPageDto extends createZodDto(auditEntriesPageSchema) {}
