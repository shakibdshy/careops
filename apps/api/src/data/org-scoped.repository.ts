import type { Model, QueryFilter, UpdateQuery, SortOrder, HydratedDocument } from 'mongoose';
import type { CursorPage } from '@careops/shared';

/**
 * Context every org-scoped query must carry. There is deliberately no way to
 * construct or use an OrgScopedRepository without one (ADR-0006): the
 * discriminator key is injected into every filter and create, so a missed
 * organization scope is a compile error in application code, not a
 * cross-tenant data leak at runtime.
 */
export interface OrgRequestContext {
  organizationId: string;
}

/**
 * Base repository for tenant-owned Mongoose collections. All read/write
 * methods merge `organizationId` into the caller's filter with the org scope
 * applied last, so a caller-supplied organizationId can never widen the
 * query — there is no unscoped method. Compound indexes on the collection
 * must lead with `organizationId` (see ADR-0006).
 */
export abstract class OrgScopedRepository<T extends { _id: unknown }> {
  protected constructor(private readonly model: Model<T>) {}

  protected orgFilter(context: OrgRequestContext, filter: QueryFilter<T> = {}): QueryFilter<T> {
    return { ...filter, organizationId: context.organizationId };
  }

  async create(context: OrgRequestContext, data: Omit<T, '_id'>): Promise<HydratedDocument<T>> {
    const doc = new this.model({ ...data, organizationId: context.organizationId });
    await doc.save();
    return doc as HydratedDocument<T>;
  }

  async findOne(
    context: OrgRequestContext,
    filter: QueryFilter<T>,
  ): Promise<HydratedDocument<T> | null> {
    return this.model.findOne(this.orgFilter(context, filter)).exec();
  }

  /**
   * Cursor-paginated page (ADR-0008): `_id` range scan, O(pageSize) at any
   * depth, stable under concurrent inserts. Fetches limit+1 to detect
   * hasMore; the sentinel never reaches the caller.
   */
  async findPage(
    context: OrgRequestContext,
    options: {
      filter?: QueryFilter<T>;
      limit: number;
      /** Last-seen _id cursor; undefined fetches the first page. */
      afterId?: string | undefined;
      sort?: Record<string, 1 | -1 | { $meta: string }>;
    },
  ): Promise<CursorPage<HydratedDocument<T>>> {
    const { filter, limit, afterId, sort } = options;
    const query: QueryFilter<T> = this.orgFilter(context, filter);
    if (afterId) {
      // _id is ObjectId-typed in mongoose's strict query casting; the string
      // form is valid at runtime and cast through the raw filter record.
      (query as Record<string, unknown>)['_id'] = { $gt: afterId };
    }
    const docs = await this.model
      .find(query)
      .sort({ _id: 1, ...sort })
      .limit(limit + 1)
      .exec();
    const hasMore = docs.length > limit;
    const items = hasMore ? docs.slice(0, limit) : docs;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? String(last._id) : undefined,
      hasMore,
    };
  }

  async findOneAndUpdate(
    context: OrgRequestContext,
    filter: QueryFilter<T>,
    update: UpdateQuery<T>,
  ): Promise<HydratedDocument<T> | null> {
    return this.model
      .findOneAndUpdate(this.orgFilter(context, filter), update, { new: true })
      .exec();
  }

  async findOneAndDelete(
    context: OrgRequestContext,
    filter: QueryFilter<T>,
  ): Promise<HydratedDocument<T> | null> {
    return this.model.findOneAndDelete(this.orgFilter(context, filter)).exec();
  }

  async count(context: OrgRequestContext, filter: QueryFilter<T> = {}): Promise<number> {
    return this.model.countDocuments(this.orgFilter(context, filter)).exec();
  }
}

export type { SortOrder };
