import * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base text-foreground placeholder:text-muted-foreground/70 disabled:opacity-50 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Browsers that size a textarea to its content in CSS (field-sizing: content - Chrome and
 * Android) need no JavaScript; elsewhere (Safari) the height is measured after each change.
 * Measuring 100+ table cells one by one forces a layout each time, so avoid it when possible.
 */
const NATIVE_AUTOSIZE = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

/** A textarea that grows with its content, so long cells never hide text. */
function Textarea({ className, value, onChange, ...props }: React.ComponentProps<'textarea'>) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || NATIVE_AUTOSIZE) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      rows={1}
      value={value}
      onChange={onChange}
      className={cn(
        'block min-h-11 w-full resize-none overflow-hidden rounded-md border border-input bg-card px-3 py-2.5 text-base leading-snug text-foreground [field-sizing:content] placeholder:text-muted-foreground/70 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input, Textarea };
