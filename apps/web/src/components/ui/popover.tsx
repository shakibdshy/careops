import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '#/lib/utils';

/**
 * Anchored popover rendered in a body portal with fixed positioning, so it is
 * never clipped by cards, tables or dialogs. Flips above the trigger when the
 * viewport bottom is near and clamps horizontally to the viewport.
 */
export function usePopover(onDismiss?: () => void) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>();
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const rect = anchor.getBoundingClientRect();
    const { width, height } = popover.getBoundingClientRect();
    const gap = 6;
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - 8 && rect.top - gap - height > 8) {
      top = rect.top - gap - height;
    }
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    setPosition({ top, left });
  }, []);

  useLayoutEffect(() => {
    // Runs before paint, so a stale position from the previous open is corrected
    // before the panel is ever visible.
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
      dismissRef.current?.();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      // Capture + stopPropagation so an enclosing Dialog keeps its own Escape
      // handler from also firing: one Escape closes only the topmost layer.
      event.stopPropagation();
      setOpen(false);
      dismissRef.current?.();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  return { open, setOpen, anchorRef, popoverRef, position, reposition };
}

export function PopoverPanel({
  popoverRef,
  position,
  className,
  children,
  testId,
}: {
  popoverRef: React.RefObject<HTMLDivElement | null>;
  position: { top: number; left: number } | undefined;
  className?: string | undefined;
  children: ReactNode;
  testId?: string | undefined;
}) {
  return createPortal(
    <div
      ref={popoverRef}
      data-testid={testId}
      data-popover-panel
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      className={cn(
        'z-[80] rounded-xl border border-border/80 bg-popover p-3 text-popover-foreground shadow-pop',
        'animate-in fade-in zoom-in-95 duration-150',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
