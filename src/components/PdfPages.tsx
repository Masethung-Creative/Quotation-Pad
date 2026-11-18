import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '@/components/AppShell';
import { cn } from '@/lib/utils';

/** Pixel width preview pages are rendered at (A4 at 150 dpi). Fixed so golden tests are stable. */
export const PREVIEW_WIDTH = 1240;

interface Props {
  pdf: Blob | Uint8Array;
  className?: string;
  /**
   * Render width in pixels. 'fit' = the width it is shown at on this screen (x pixel ratio,
   * at most PREVIEW_WIDTH): far less drawing work on a phone.
   */
  width?: number | 'fit';
  /** Pages to reserve space for until the first drawing is ready (avoids the layout jumping). */
  placeholders?: number;
  maxPages?: number;
  /** Something drawn over one page (the draggable signature). */
  overlay?: { page: number; node: ReactNode } | null;
  onRendered?: (pages: number) => void;
  label?: string;
}

interface Shown {
  canvases: HTMLCanvasElement[];
  total: number;
}

function CanvasHost({ canvas }: { canvas: HTMLCanvasElement }) {
  return (
    <div
      className="contents"
      ref={(el) => {
        if (el && el.firstChild !== canvas) el.replaceChildren(canvas);
      }}
    />
  );
}

/**
 * Draws the pages of a PDF with pdf.js - an exact preview of the output file. The previous
 * pages stay on screen until the new ones are ready, so re-rendering never flickers.
 */
export function PdfPages({ pdf, className, width = PREVIEW_WIDTH, maxPages = 8, overlay, onRendered, label = 'Page', placeholders = 0 }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const callback = useRef(onRendered);
  callback.current = onRendered;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      const { openPdf, renderPage } = await import('@/extract/pdfjs');
      const bytes = pdf instanceof Blob ? await pdf.arrayBuffer() : pdf;
      const { doc, close } = await openPdf(bytes);
      const px =
        width === 'fit'
          ? Math.min(PREVIEW_WIDTH, Math.max(480, Math.round((host.current?.clientWidth || 400) * Math.min(window.devicePixelRatio || 1, 2.5))))
          : width;
      try {
        const total = doc.numPages;
        const canvases: HTMLCanvasElement[] = [];
        for (let n = 1; n <= Math.min(total, maxPages); n++) {
          if (cancelled) return;
          const canvas = await renderPage(await doc.getPage(n), { width: px });
          canvas.dataset.page = String(n);
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `${label} ${n} of ${total}`);
          canvas.className = 'block h-auto w-full rounded-sm bg-white shadow-[0_1px_3px_rgba(27,36,51,0.25)]';
          canvases.push(canvas);
        }
        if (cancelled) return;
        setShown({ canvases, total });
        setStatus('ready');
        callback.current?.(total);
      } finally {
        await close().catch(() => undefined);
      }
    })().catch(() => {
      if (!cancelled) setStatus('error');
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, width, maxPages, label]);

  return (
    <div ref={host} className={cn('flex flex-col gap-3', className)} data-testid="pdf-pages" data-status={status} data-pages={shown?.total ?? 0}>
      {shown?.canvases.map((canvas, i) => (
        <div key={i} className="relative" data-page-wrapper={i + 1}>
          <CanvasHost canvas={canvas} />
          {overlay && overlay.page === i + 1 ? <div className="absolute inset-0">{overlay.node}</div> : null}
        </div>
      ))}
      {status === 'loading' && !shown ? (
        placeholders > 0 ? (
          Array.from({ length: Math.min(placeholders, maxPages) }, (_, i) => (
            <div key={i} className="flex aspect-[210/297] w-full items-center justify-center rounded-sm bg-white text-sm text-muted-foreground shadow-[0_1px_3px_rgba(27,36,51,0.25)]">
              {i === 0 ? (
                <span className="flex items-center gap-2">
                  <Spinner /> Drawing the pages
                </span>
              ) : null}
            </div>
          ))
        ) : (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner /> Drawing the pages
          </div>
        )
      ) : null}
      {status === 'error' ? <p className="py-4 text-center text-sm text-destructive">The preview could not be drawn. The PDF itself is fine and can still be downloaded.</p> : null}
      {shown && shown.total > shown.canvases.length ? (
        <p className="text-center text-sm text-muted-foreground">
          Showing the first {shown.canvases.length} of {shown.total} pages. The PDF has all of them.
        </p>
      ) : null}
    </div>
  );
}
