import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '#/lib/utils';

/**
 * Lightweight modal: scrim click + Escape close, panel focused on mount.
 * Mount it conditionally — there is no open prop.
 */
export function Dialog({
  onClose,
  label,
  testId,
  overlayTestId,
  className,
  children,
}: {
  onClose: () => void;
  label: string;
  testId?: string;
  overlayTestId?: string;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid={testId}
    >
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[3px] animate-in fade-in duration-200"
        onClick={onClose}
        data-testid={overlayTestId}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full max-w-md rounded-2xl border border-border/70 bg-card text-card-foreground shadow-pop animate-in fade-in zoom-in-95 slide-in-from-bottom-3 duration-200 focus:outline-none',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
