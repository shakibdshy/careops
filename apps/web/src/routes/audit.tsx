import { createFileRoute, Link } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { auditEntriesPageSchema, type AuditEntry, type WorkspaceMe } from '@careops/shared';
import {
  ArrowLeft,
  CircleAlert,
  History,
  PencilLine,
  Plus,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { AppShell } from '#/components/app-shell';
import { PageHeader } from '#/components/page-header';
import { PageLoading } from '#/components/page-loading';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Avatar } from '#/components/ui/avatar';
import { Badge } from '#/components/ui/badge';
import { Button } from '#/components/ui/button';
import { Card } from '#/components/ui/card';
import { EmptyState } from '#/components/ui/empty-state';
import { Skeleton } from '#/components/ui/skeleton';
import { apiGet } from '#/lib/api';
import { useWorkspace } from '#/lib/use-workspace';
import { cn } from '#/lib/utils';

export const Route = createFileRoute('/audit')({ component: AuditPage });

const ACTION_META: Record<
  AuditEntry['action'],
  { icon: LucideIcon; variant: 'success' | 'info' | 'destructive'; rail: string }
> = {
  create: { icon: Plus, variant: 'success', rail: 'bg-success' },
  update: { icon: PencilLine, variant: 'info', rail: 'bg-info' },
  delete: { icon: Trash2, variant: 'destructive', rail: 'bg-destructive' },
};

function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const stamp = date.toISOString();
  return `${stamp.slice(0, 10)} ${stamp.slice(11, 19)} UTC`;
}

function AuditPage() {
  const me = useWorkspace('/audit');
  if (!me) {
    return <PageLoading />;
  }
  return <AuditTrail me={me} />;
}

function AuditTrail({ me }: { me: WorkspaceMe }) {
  const auditQuery = useInfiniteQuery({
    queryKey: ['audit-entries'],
    queryFn: ({ pageParam }) =>
      apiGet(
        `/api/audit-entries${pageParam ? `?cursor=${pageParam}` : ''}`,
        auditEntriesPageSchema,
      ),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const canBrowse = me.organization.role === 'owner' || me.organization.role === 'admin';
  if (!canBrowse) {
    return (
      <AppShell me={me} active="audit">
        <PageHeader eyebrow={me.organization.name} title="Audit trail" />
        <Card className="mt-6 max-w-lg">
          <EmptyState
            icon={ShieldAlert}
            title="Owners and admins only"
            hint="Audit entries are visible to owners and admins. Ask your organization owner for access."
          />
          <div className="flex justify-center pb-6">
            <Button asChild variant="outline">
              <Link to="/patients">
                <ArrowLeft className="size-4" /> Back to patients
              </Link>
            </Button>
          </div>
        </Card>
      </AppShell>
    );
  }

  const entries = auditQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <AppShell me={me} active="audit">
      <PageHeader
        eyebrow={me.organization.name}
        title="Audit trail"
        description="Append-only record of every mutation — who changed what, and the before → after."
        actions={
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <History className="size-3.5" />
            Newest first
          </Badge>
        }
      />

      {auditQuery.isLoading && (
        <div className="mt-6 grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Card key={index} className="grid gap-3 p-4">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-16 w-full" />
            </Card>
          ))}
        </div>
      )}
      {auditQuery.isError && (
        <Alert variant="destructive" className="mt-6">
          <CircleAlert />
          <AlertDescription>{String(auditQuery.error.message)}</AlertDescription>
        </Alert>
      )}

      {auditQuery.data && entries.length === 0 && (
        <Card className="mt-6">
          <EmptyState
            icon={History}
            title="No audit entries yet"
            hint="Mutations to patients and appointments appear here as they happen."
          />
        </Card>
      )}

      {auditQuery.data && entries.length > 0 && (
        <ul className="mt-6 grid gap-3" data-testid="audit-list">
          {entries.map((entry, index) => {
            const meta = ACTION_META[entry.action];
            const Icon = meta.icon;
            return (
              <li key={entry.id} data-testid="audit-row" className="relative animate-rise">
                <Card
                  className={cn(
                    'relative overflow-hidden p-4 pl-5 lg:p-5 lg:pl-6',
                    index > 5 && 'animate-none',
                  )}
                >
                  <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', meta.rail)} />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Badge variant={meta.variant} className="gap-1 capitalize">
                      <Icon className="size-3" />
                      {entry.action}
                    </Badge>
                    <span className="text-sm font-medium">{entry.entity}</span>
                    <span className="font-mono text-[11px] text-muted-foreground/80">
                      {entry.entityId.slice(0, 8)}…
                    </span>
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatStamp(entry.at)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                    <Avatar name={entry.actorEmail} size="sm" />
                    <span className="truncate">{entry.actorEmail}</span>
                  </div>
                  <div className="mt-3 grid gap-2 lg:grid-cols-2">
                    <div className="rounded-lg border border-destructive/15 bg-destructive/5 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-destructive">
                        Before
                      </p>
                      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/80">
                        − {JSON.stringify(entry.before)}
                      </pre>
                    </div>
                    <div className="rounded-lg border border-success/15 bg-success/5 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-success">
                        After
                      </p>
                      <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/80">
                        + {JSON.stringify(entry.after)}
                      </pre>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {auditQuery.hasNextPage && (
        <div className="mt-5 flex justify-center">
          <Button
            variant="outline"
            disabled={auditQuery.isFetchingNextPage}
            data-testid="audit-load-more"
            onClick={() => {
              void auditQuery.fetchNextPage();
            }}
          >
            {auditQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </AppShell>
  );
}
