import { lazy, Suspense, useRef, useState } from 'react';
import { Camera, CircleAlert, FileUp, RotateCcw, Settings as SettingsIcon } from 'lucide-react';
import { BottomBar, Page, PrivacyNote, TopBar } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/badge';
import type { ExtractProgress } from '@/extract/types';
import { ACCEPT_ATTR } from '@/ingest/detect';
import { friendlyError, type FriendlyError } from '@/lib/errors';
import { Link, useNavigate } from '@/lib/router';

// The recent list needs the database library; it loads after the upload screen is on screen.
const RecentList = lazy(() => import('./RecentList'));

/** Overall 0..1 progress from the stage + page information the extractor reports. */
export function overallProgress(p: ExtractProgress): number | null {
  if (p.stage === 'structure') return 0.97;
  if (p.stage === 'ocr-load') return null;
  if (!p.pages || !p.page) return null;
  const perPage = 1 / p.pages;
  const within = p.stage === 'ocr' ? 0.15 + 0.85 * (p.progress ?? 0) : 0.05;
  return Math.min(0.95, (p.page - 1) * perPage + within * perPage);
}

/**
 * Step 1: Upload. Mirrors the static copy of this screen in index.html (shown before any
 * JavaScript runs), so the swap is invisible. Keep the two in step.
 */
export default function Home() {
  const navigate = useNavigate();
  const [reading, setReading] = useState<{ name: string; progress: ExtractProgress } | null>(null);
  const [error, setError] = useState<(FriendlyError & { file: File }) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const runId = useRef(0);

  const start = async (file: File | undefined, lowMemory = false) => {
    if (!file) return;
    const run = ++runId.current;
    setError(null);
    setReading({ name: file.name, progress: { stage: 'reading', message: 'Opening the file' } });
    try {
      const [{ createConversion }, { getSettings }] = await Promise.all([import('@/pipeline/convert'), import('@/db/db')]);
      const settings = await getSettings();
      const id = await createConversion(file, {
        langs: settings.ocr_langs,
        lowMemory,
        onProgress: (progress) => {
          if (run === runId.current) setReading({ name: file.name, progress });
        },
      });
      if (run !== runId.current) return;
      navigate(`/template/${id}`);
    } catch (err) {
      if (run !== runId.current) return;
      setReading(null);
      setError({ ...friendlyError(err), file });
    }
  };

  const tryAgain = () => {
    if (!error) return;
    if (error.retry === 'pick') fileInput.current?.click();
    else void start(error.file, error.retry === 'low-memory');
  };

  if (reading) {
    const value = overallProgress(reading.progress);
    const scanning = reading.progress.stage === 'ocr' || reading.progress.stage === 'ocr-load';
    return (
      <>
        <TopBar title="Reading..." subtitle={reading.name} />
        <Page>
          <Card className="mt-6 p-5" data-testid="extract-progress">
            <p className="text-lg font-semibold" aria-live="polite">
              {reading.progress.message}
              {reading.progress.message.endsWith('...') ? '' : '...'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {scanning ? 'This is a scan or a photo, so every word is being read. On a phone this takes up to half a minute per page.' : 'This usually takes a few seconds.'}
            </p>
            <Progress className="mt-4" value={value} label={reading.progress.message} />
          </Card>
          <PrivacyNote className="mt-6" />
        </Page>
        <BottomBar>
          <Button
            variant="outline"
            size="lg"
            className="flex-1"
            onClick={() => {
              runId.current++;
              setReading(null);
            }}
          >
            Cancel
          </Button>
        </BottomBar>
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Quotation Pad"
        subtitle="Any quotation, on your letterpad."
        actions={
          <Link to="/settings" aria-label="Settings" className="flex size-11 items-center justify-center rounded-md hover:bg-muted">
            <SettingsIcon className="size-5" />
          </Link>
        }
      />
      <Page>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT_ATTR}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="quotation-file"
          onChange={(e) => {
            void start(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void start(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        {error ? (
          <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-red-950" data-testid="upload-error" data-kind={error.kind}>
            <p className="flex items-center gap-2 font-semibold">
              <CircleAlert className="size-5 shrink-0 text-red-700" /> {error.title}
            </p>
            <p className="mt-1 text-sm">{error.message}</p>
            <Button className="mt-3" onClick={tryAgain} data-testid="try-again">
              <RotateCcw /> Try again
            </Button>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-3 rounded-xl bg-primary px-6 py-10 text-primary-foreground shadow-md transition-colors hover:bg-primary/90 active:translate-y-px"
          data-testid="upload-button"
        >
          <span className="flex size-16 items-center justify-center rounded-full bg-white/15">
            <FileUp className="size-8" />
          </span>
          <span className="text-xl font-semibold">Upload quotation</span>
          <span className="text-sm text-primary-foreground/80">PDF, Word (.docx) or photo · up to 20 MB</span>
        </button>

        {/* Phones and tablets only (touch screens): open the camera directly. */}
        <Button variant="outline" size="lg" className="mt-3 hidden w-full [@media(pointer:coarse)]:flex" onClick={() => cameraInput.current?.click()} data-testid="camera-button">
          <Camera /> Take a photo of a quotation
        </Button>

        <PrivacyNote className="mt-8" />

        <Suspense fallback={null}>
          <RecentList />
        </Suspense>
      </Page>
    </>
  );
}
