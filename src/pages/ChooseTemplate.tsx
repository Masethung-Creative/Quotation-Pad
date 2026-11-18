import { useEffect, useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { FullPageLoading, Page, Spinner, TopBar } from '@/components/AppShell';
import { PdfPages } from '@/components/PdfPages';
import { Badge } from '@/components/ui/badge';
import { db, getSettings, lastTemplate, type Conversion } from '@/db/db';
import { useNavigate, useParams } from '@/lib/router';
import { cn } from '@/lib/utils';
import { currentDoc, renderForTemplate } from '@/pipeline/convert';
import { templateAssetUrl, TEMPLATES } from '@/templates';

type Thumb = { status: 'loading' } | { status: 'ready'; pdf: Uint8Array; pages: number } | { status: 'error' };

/** Step 3: one large card per company, showing this quotation already on that letterhead. */
export default function ChooseTemplate() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conv, setConv] = useState<Conversion | null | undefined>(undefined);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, Thumb>>({});

  useEffect(() => {
    void Promise.all([db.conversions.get(id!), lastTemplate.get()]).then(async ([c, last]) => {
      setPreferred(c?.template_id ?? last);
      if (c) {
        const [{ refreshIfOutdated }, settings] = await Promise.all([import('@/pipeline/convert'), getSettings()]);
        c = await refreshIfOutdated(c, { langs: settings.ocr_langs });
      }
      setConv(c ?? null);
    });
  }, [id]);

  useEffect(() => {
    if (!conv) return;
    const doc = currentDoc(conv);
    if (!doc) return;
    let cancelled = false;
    // Render the pre-selected template first so the most likely choice appears soonest.
    const order = [...TEMPLATES].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    (async () => {
      for (const t of order) {
        if (cancelled) return;
        setThumbs((s) => ({ ...s, [t.id]: { status: 'loading' } }));
        try {
          const result = await renderForTemplate(doc, t.id, conv.name, conv.pages);
          if (!cancelled) setThumbs((s) => ({ ...s, [t.id]: { status: 'ready', pdf: result.pdf, pages: result.pages } }));
        } catch {
          if (!cancelled) setThumbs((s) => ({ ...s, [t.id]: { status: 'error' } }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conv, preferred]);

  const choose = async (templateId: string) => {
    if (!conv) return;
    await Promise.all([db.conversions.update(conv.id, { template_id: templateId, output_pdf: null }), lastTemplate.set(templateId)]);
    navigate(`/review/${conv.id}`);
  };

  if (conv === undefined) return <FullPageLoading label="Opening quotation" />;
  if (conv === null) {
    return (
      <>
        <TopBar title="Choose template" back="/" />
        <Page>
          <p className="py-10 text-center text-muted-foreground">This quotation is no longer on this device.</p>
        </Page>
      </>
    );
  }

  return (
    <>
      <TopBar title="Choose template" subtitle={conv.name} back={`/type/${conv.id}`} />
      <Page>
        <p className="mb-4 text-sm text-muted-foreground">Tap the company this {conv.doc_type === 'invoice' ? 'invoice' : 'quotation'} should go out under.</p>
        <div className="grid gap-4 sm:grid-cols-2" data-testid="template-cards">
          {TEMPLATES.map((t) => {
            const thumb = thumbs[t.id];
            const selected = t.id === preferred;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => void choose(t.id)}
                aria-label={`Use ${t.display_name}`}
                data-testid="template-card"
                data-template={t.id}
                className={cn(
                  'group flex flex-col overflow-hidden rounded-xl border-2 bg-card text-left shadow-sm transition-shadow hover:shadow-md',
                  selected ? 'border-primary' : 'border-transparent ring-1 ring-border',
                )}
              >
                <div className="relative aspect-[210/150] w-full overflow-hidden bg-muted">
                  {thumb?.status === 'ready' ? (
                    <PdfPages pdf={thumb.pdf} width={640} maxPages={1} className="pointer-events-none [&_canvas]:rounded-none [&_canvas]:shadow-none" label={t.display_name} />
                  ) : thumb?.status === 'error' ? (
                    <div className="flex h-full items-center justify-center gap-2 text-sm text-destructive">
                      <CircleAlert className="size-4" /> Preview not available
                    </div>
                  ) : (
                    <div className="relative h-full">
                      {templateAssetUrl(t.id, t.thumbnail) ? <img src={templateAssetUrl(t.id, t.thumbnail)} alt="" className="size-full object-cover object-top opacity-80" /> : null}
                      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                        <Spinner />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex min-h-14 items-center gap-2 border-t px-4 py-3">
                  <span className="flex-1 text-base font-semibold leading-tight">{t.display_name}</span>
                  {selected ? (
                    <Badge>
                      <Check /> Last used
                    </Badge>
                  ) : null}
                  {thumb?.status === 'ready' ? <span className="text-xs text-muted-foreground">{thumb.pages === 1 ? '1 page' : `${thumb.pages} pages`}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </Page>
    </>
  );
}
