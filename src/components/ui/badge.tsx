import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/** Badge and progress bar: plain elements (no Radix), so the first screen stays small. */

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap [&_svg]:size-3.5', {
  variants: {
    variant: {
      default: 'bg-secondary text-secondary-foreground',
      muted: 'bg-muted text-muted-foreground',
      success: 'bg-emerald-100 text-emerald-900',
      flag: 'bg-flag text-flag-foreground',
      destructive: 'bg-red-100 text-red-900',
    },
  },
  defaultVariants: { variant: 'default' },
});

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

function Progress({ value, className, label }: { value: number | null; className?: string; label?: string }) {
  const pct = value === null ? null : Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      className={cn('h-2.5 w-full overflow-hidden rounded-full bg-secondary', className)}
    >
      <div
        className={cn('h-full rounded-full bg-primary transition-[width] duration-300', pct === null && 'w-1/3 animate-pulse')}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

export { Badge, Progress };
