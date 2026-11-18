import { useEffect, useState } from 'react';
import { Check, ChevronRight, FileText, ReceiptIndianRupee } from 'lucide-react';
import { FullPageLoading, Page, TopBar } from '@/components/AppShell';
import { Badge } from '@/components/ui/badge';
import { db, type Conversion } from '@/db/db';
import { useNavigate, useParams } from '@/lib/router';
import { cn } from '@/lib/utils';
import { DOC_TYPES, guessDocType, withDocTitle, type DocType } from '@/pipeline/docType';

const ICONS: Record<DocType, typeof FileText> = { quotation: FileText, invoice: ReceiptIndianRupee };

/** Step 3: invoice or quotation. Sets the printed title; the letterheads are the same for both. */
export default function ChooseType() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conv, setConv] = useState<Conversion | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void db.conversions.get(id!).then((c) => setConv(c ?? null));
  }, [id]);

  if (conv === undefined) return <FullPageLoading label="Opening" />;
  if (conv === null) {
    return (
      <>
        <TopBar title="Invoice or quotation?" back="/" />
        <Page>
          <p className="py-10 text-center text-muted-foreground">This document is no longer on this device.</p>
        </Page>
      </>
    );
  }

  // The current choice, else the app's guess from the words in the document.
  const suggested = conv.doc_type ?? guessDocType(conv.edited_json ?? conv.extracted_json);

  const choose = async (type: DocType) => {
    if (busy) return;
    setBusy(true);
    try {
      await db.conversions.update(conv.id, {
        doc_type: type,
        // An edited document gets the new title too; the finished PDF must be made again.
        ...(conv.edited_json ? { edited_json: withDocTitle(conv.edited_json, type) } : {}),
        ...(conv.doc_type !== type ? { output_pdf: null, status: conv.status === 'rendered' ? 'reviewed' : conv.status } : {}),
      });
      navigate(`/template/${conv.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar title="Invoice or quotation?" subtitle={conv.name} back="/" />
      <Page>
        <p className="mb-4 text-sm text-muted-foreground">Tap what this document is. It sets the title printed on the letterhead.</p>
        <div className="grid gap-3 sm:grid-cols-2" data-testid="type-cards">
          {(Object.keys(DOC_TYPES) as DocType[]).map((type) => {
            const t = DOC_TYPES[type];
            const Icon = ICONS[type];
            const selected = type === suggested;
            return (
              <button
                key={type}
                type="button"
                disabled={busy}
                onClick={() => void choose(type)}
                aria-label={`This is a ${t.label}`}
                aria-pressed={selected}
                data-testid="type-card"
                data-type={type}
                data-suggested={selected ? 'true' : 'false'}
                className={cn(
                  'flex min-h-24 items-center gap-4 rounded-xl border-2 bg-card p-4 text-left shadow-sm transition-shadow hover:shadow-md active:translate-y-px disabled:opacity-60',
                  selected ? 'border-primary' : 'border-transparent ring-1 ring-border',
                )}
              >
                <span className={cn('flex size-12 shrink-0 items-center justify-center rounded-full', selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>
                  <Icon className="size-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-semibold leading-tight">{t.label}</span>
                    {selected ? (
                      <Badge>
                        <Check /> {conv.doc_type ? 'Chosen' : 'Suggested'}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">{t.hint}</span>
                  <span className="mt-1 block text-xs font-semibold tracking-wide text-muted-foreground">Title: {t.title}</span>
                </span>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      </Page>
    </>
  );
}
