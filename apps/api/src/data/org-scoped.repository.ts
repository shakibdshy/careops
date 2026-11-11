import type { Model, QueryFilter, UpdateQuery, SortOrder, HydratedDocument } from 'mongoose';

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
 * methods prepend `organizationId` to the caller's filter; callers cannot
 * bypass it — there is no unscoped method. Compound indexes on the collection
 * must lead with `organizationId` (see ADR-0006).
 */
export abstract class OrgScopedRepository<T extends { _id: unknown }> {
  protected constructor(private readonly model: Model<T>) {}

  protected orgFilter(context: OrgRequestContext, filter: QueryFilter<T> = {}): QueryFilter<T> {
    return { organizationId: context.organizationId, ...filter };
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

  async findPage(
    context: OrgRequestContext,
    options: {
      filter?: QueryFilter<T>;
      limit: number;
      /** Last-seen _id cursor; undefined fetches the first page. */
      afterId?: string;
      sort?: Record<string, 1 | -1 | { $meta: string }>;
    },
  ): Promise<HydratedDocument<T>[]> {
    const { filter, limit, afterId, sort } = options;
    const query: QueryFilter<T> = this.orgFilter(context, filter);
    if (afterId) {
      // Cursor pagination per ADR-0008: _id range scan, O(pageSize) at depth.
      // _id is ObjectId-typed in mongoose's strict query casting; the string
      // form is valid at runtime and cast through the raw filter record.
      (query as Record<string, unknown>)['_id'] = { $gt: afterId };
    }
    return this.model
      .find(query)
      .sort({ _id: 1, ...sort })
      .limit(limit + 1)
      .exec();
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
