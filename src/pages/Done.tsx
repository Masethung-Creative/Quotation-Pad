import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CircleAlert, CircleCheck, Download, FilePlus2, Pencil, Share2 } from 'lucide-react';
import { BottomBar, FullPageLoading, Page, PrivacyNote, TopBar } from '@/components/AppShell';
import { PdfPages } from '@/components/PdfPages';
import { Button } from '@/components/ui/button';
import { db, getSettings, type Conversion } from '@/db/db';
import { formatBytes } from '@/lib/format';
import { Link, useNavigate, useParams } from '@/lib/router';
import { canShareFile, downloadBlob, shareFile } from '@/lib/utils';
import { getTemplate } from '@/templates';

/** Step 5: Download or Share (WhatsApp, Gmail...). Share falls back to a download. */
export default function Done() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conv, setConv] = useState<Conversion | null | undefined>(undefined);

  useEffect(() => {
    void db.conversions.get(id!).then(async (c) => {
      if (c) {
        // Made by an older version of the reader: read it again (the editor then opens).
        const [{ refreshIfOutdated }, settings] = await Promise.all([import('@/pipeline/convert'), getSettings()]);
        c = await refreshIfOutdated(c, { langs: settings.ocr_langs });
      }
      setConv(c ?? null);
    });
  }, [id]);

  const pdf = conv?.output_pdf ?? null;
  const fileName = conv?.output_name ?? 'Quotation.pdf';
  const shareable = useMemo(() => (pdf ? canShareFile(pdf, fileName) : false), [pdf, fileName]);

  useEffect(() => {
    // Opened without a finished PDF (e.g. an old link): back to the editor.
    if (conv && !conv.output_pdf) navigate(conv.template_id ? `/review/${conv.id}` : `/template/${conv.id}`, { replace: true });
  }, [conv, navigate]);

  if (conv === undefined) return <FullPageLoading />;
  if (conv === null || !pdf) {
    return (
      <>
        <TopBar title="Quotation" back="/" />
        <Page>
          <p className="py-10 text-center text-muted-foreground">This quotation is no longer on this device.</p>
        </Page>
      </>
    );
  }

  const download = () => downloadBlob(pdf, fileName);
  const share = async () => {
    if (!shareable) {
      download();
      toast('Sharing is not available here, so the PDF was downloaded instead.');
      return;
    }
    try {
      await shareFile(pdf, fileName, fileName.replace(/\.pdf$/i, ''));
    } catch {
      download();
      toast('Sharing did not work on this device, so the PDF was downloaded instead.');
    }
  };
  const pdfCheck = conv.warnings.filter((w) => w.startsWith('PDF check:'));
  const template = getTemplate(conv.template_id);

  return (
    <>
      <TopBar title="Done" subtitle={fileName} back={`/review/${conv.id}`} />
      <Page withBar>
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-950" data-testid="done-banner">
          <CircleCheck className="size-6 shrink-0 text-emerald-700" />
          <div className="min-w-0">
            <p className="font-semibold leading-tight">Ready on {template?.display_name ?? 'your letterpad'}</p>
            <p className="truncate text-sm text-emerald-900/80" data-testid="file-name">
              {fileName}
            </p>
            <p className="text-sm text-emerald-900/80">
              {conv.output_pages} {conv.output_pages === 1 ? 'page' : 'pages'} · {formatBytes(pdf.size)}
            </p>
          </div>
        </div>

        {pdfCheck.map((w, i) => (
          <div key={i} role="alert" className="mb-3 flex gap-2.5 rounded-lg border border-amber-300 bg-flag/60 p-3 text-sm text-flag-foreground">
            <CircleAlert className="mt-0.5 size-4.5 shrink-0" />
            <p>{w.replace(/^PDF check:\s*/, '')}</p>
          </div>
        ))}

        <PdfPages pdf={pdf} width="fit" placeholders={conv.output_pages} />

        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button asChild variant="outline">
            <Link to={`/review/${conv.id}`}>
              <Pencil /> Edit again
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/">
              <FilePlus2 /> New quotation
            </Link>
          </Button>
        </div>
        <PrivacyNote className="mt-6" />
      </Page>

      <BottomBar>
        <Button variant="outline" size="lg" className="flex-1" onClick={download} data-testid="download">
          <Download /> Download PDF
        </Button>
        <Button size="lg" className="flex-1" onClick={() => void share()} data-testid="share">
          <Share2 /> Share
        </Button>
      </BottomBar>
    </>
  );
}
