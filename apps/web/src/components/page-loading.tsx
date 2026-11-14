import { LogoMark } from '#/components/logo';

/** Full-viewport loading state shown while the workspace session resolves. */
export function PageLoading({ label = 'Loading workspace…' }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3 animate-in fade-in duration-300">
        <LogoMark className="size-10 animate-pulse" />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
