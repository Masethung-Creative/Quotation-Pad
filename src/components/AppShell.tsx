import * as React from 'react';
import { Link, useNavigate } from '@/lib/router';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn('size-9', className)} aria-hidden="true">
      <rect x="6" y="3" width="36" height="42" rx="6" fill="#1d3a6b" />
      <rect x="6" y="3" width="36" height="11" rx="6" fill="#e0a526" />
      <rect x="6" y="9" width="36" height="5" fill="#e0a526" />
      <rect x="13" y="21" width="22" height="3" rx="1.5" fill="#fff" />
      <rect x="13" y="28" width="22" height="3" rx="1.5" fill="#fff" opacity=".8" />
      <rect x="13" y="35" width="13" height="3" rx="1.5" fill="#fff" opacity=".6" />
    </svg>
  );
}

interface TopBarProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Path to go back to; omit on the home screen. */
  back?: string | (() => void);
  actions?: React.ReactNode;
}

export function TopBar({ title, subtitle, back, actions }: TopBarProps) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 pt-safe backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-1 px-2">
        {back !== undefined ? (
          <button
            type="button"
            aria-label="Back"
            onClick={() => (typeof back === 'function' ? back() : navigate(back))}
            className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted"
          >
            <ArrowLeft className="size-5" />
          </button>
        ) : (
          <Link to="/" className="flex size-11 shrink-0 items-center justify-center" aria-label="Quotation Pad home">
            <Logo />
          </Link>
        )}
        <div className="min-w-0 flex-1 px-1">
          <h1 className="truncate text-[17px] font-semibold leading-tight">{title}</h1>
          {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Page({ children, className, withBar = false }: { children: React.ReactNode; className?: string; withBar?: boolean }) {
  return <main className={cn('mx-auto w-full max-w-3xl px-4 py-4', withBar ? 'pb-32' : 'pb-10', className)}>{children}</main>;
}

/** Bottom action bar: the primary actions always sit under the thumb. */
export function BottomBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 shadow-[0_-4px_16px_rgba(27,36,51,0.08)] backdrop-blur">
      <div className={cn('mx-auto flex w-full max-w-3xl items-center gap-2 px-3 pt-2.5 pb-safe', className)}>{children}</div>
    </div>
  );
}

export function PrivacyNote({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground', className)}>
      <ShieldCheck className="size-4 shrink-0 text-success" />
      Your files stay on this device. Nothing is uploaded.
    </p>
  );
}

export function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-input bg-card/60 px-5 py-8 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-secondary text-primary [&_svg]:size-6">{icon}</div>
      <p className="text-base font-semibold">{title}</p>
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block size-5 animate-spin rounded-full border-2 border-current border-r-transparent', className)} role="status" aria-label="Loading" />;
}

export function FullPageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 text-muted-foreground">
      <Spinner className="size-7 text-primary" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

/** Object URL for a blob that is revoked automatically. */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}
