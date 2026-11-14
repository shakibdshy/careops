import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '#/lib/utils';

/** Native select dressed in the design system: reliable keyboard + mobile UX. */
const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(
  ({ className, children, ...props }, ref) => (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        className="h-10 w-full appearance-none rounded-lg border border-input bg-card pl-3 pr-9 text-sm shadow-xs transition-[color,border-color,box-shadow] duration-150 hover:border-ring/30 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive/60"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  ),
);
Select.displayName = 'Select';

export { Select };
