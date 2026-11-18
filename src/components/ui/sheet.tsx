import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Bottom sheet on phones (thumb reach), centred dialog on larger screens.
 * Built on the Radix dialog, so focus trapping and Escape work.
 */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetContent({ className, children, title, description, ...props }: React.ComponentProps<typeof DialogPrimitive.Content> & { title: string; description?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/45" />
      <DialogPrimitive.Content
        data-slot="sheet"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] animate-sheet-in flex-col rounded-t-xl bg-card shadow-2xl outline-none',
          'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-base font-semibold leading-tight">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-0.5 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close className="-mr-2 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="size-5" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 pb-safe">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;

function MenuContent({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={6}
        collisionPadding={10}
        className={cn('z-50 min-w-52 animate-fade-in rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

function MenuItem({ className, destructive, ...props }: React.ComponentProps<typeof MenuPrimitive.Item> & { destructive?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-md px-3 text-[15px] outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:size-4.5 [&_svg]:text-muted-foreground',
        destructive && 'text-destructive [&_svg]:text-destructive',
        className,
      )}
      {...props}
    />
  );
}

function MenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground', className)} {...props} />;
}

function MenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-border', className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, Menu, MenuTrigger, MenuContent, MenuItem, MenuLabel, MenuSeparator };
