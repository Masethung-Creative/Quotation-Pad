import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { toast } from 'sonner';
import { Check, CheckCircle2, ChevronRight, CircleAlert, Eye, ListChecks, MoreVertical, Pencil, RotateCcw, ScanText, Stamp, Trash2, TriangleAlert } from 'lucide-react';
import { BottomBar, FullPageLoading, Page, Spinner, TopBar, useObjectUrl } from '@/components/AppShell';
import { PdfPages } from '@/components/PdfPages';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/misc';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Sheet, SheetContent } from '@/components/ui/sheet';
import { db, getSettings, signaturePosition, type Conversion, type SignChoice } from '@/db/db';
import type { ExtractProgress } from '@/extract/types';
import { friendlyError } from '@/lib/errors';
import { useNavigate, useParams } from '@/lib/router';
import { cn, debounce, uid } from '@/lib/utils';
import { currentDoc, finalPdf, outputFileName, renderForTemplate, renderKey, verifyOutput } from '@/pipeline/convert';
import type { RenderResult } from '@/render';
import { DEFAULT_OFFSET, type SignatureOffset } from '@/render/signature';
import { BLOCK_ICON, EditPanel } from '@/review/EditPanel';
import { fromEditor, newBlock, senderLetterhead, toEditor, type EditorBlock } from '@/review/model';
import { BLOCK_LABEL, blockText, docText, type Block, type BlockType, type LowConfidence } from '@/schema/canonical';
import { SignatureOverlay } from '@/signature/SignatureOverlay';
import { SignatureSheet } from '@/signature/SignatureSheet';
import { SignPanel } from '@/signature/SignPanel';
import { getTemplate, TEMPLATES } from '@/templates';
import { compareCoverage, subtractTokens } from '@/validate/coverage';
import { checkDocument, type Issue } from '@/validate/totals';

const FLAG_SELECTOR = '[data-flag="true"], mark.flag';

const ADDABLE: { type: BlockType; hint: string }[] = [
  { type: 'paragraph', hint: 'Address, subject, any text' },
  { type: 'heading', hint: 'A title such as QUOTATION' },
  { type: 'meta', hint: 'Ref No, Date' },
  { type: 'table', hint: 'Items with quantity, rate, amount' },
  { type: 'totals', hint: 'Sub total, GST, grand total' },
  { type: 'list', hint: 'Terms and conditions' },
  { type: 'spacer', hint: 'Empty space between parts' },
];

type Panel = null | 'details' | 'add' | 'confirm' | 'signature';

/** Step 4: Review & sign. Preview and Edit are tabs on a phone, side by side on a desktop. */
export default function Review() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conv, setConv] = useState<Conversion | null | undefined>(undefined);
  const [blocks, setBlocks] = useState<EditorBlock[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [tab, setTab] = useState<'preview' | 'edit'>('preview');
  const [panel, setPanel] = useState<Panel>(null);
  const [addAt, setAddAt] = useState(0);
  const [render, setRender] = useState<{ key: string; result: RenderResult } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [rereading, setRereading] = useState<ExtractProgress | null>(null);
  const [leftOut, setLeftOutState] = useState<{ sourceText: string; removed: string[] }>({ sourceText: '', removed: [] });
  const [letterheadHint, setLetterheadHint] = useState(true);
  const [sign, setSign] = useState<SignChoice>({ on: false, signature_id: null });
  const [offset, setOffset] = useState<SignatureOffset>(DEFAULT_OFFSET);
  const [flagCount, setFlagCount] = useState(0);
  // The edit list (a field per table cell) is built in React's interruptible mode after the
  // first paint, so opening a long quotation never freezes the phone.
  const [editReady, setEditReady] = useState(false);
  const loaded = useRef(false);
  const editRef = useRef<HTMLDivElement>(null);
  const jumpIndex = useRef(-1);
  const renderedTemplate = useRef<string | null>(null);

  const signatures = useLiveQuery(() => db.signatures.orderBy('created_at').toArray(), []);
  const def = getTemplate(templateId);

  const load = useCallback(async () => {
    let c = await db.conversions.get(id!);
    if (c) {
      // Read again with the latest reader if this quotation predates it and was never edited.
      const [{ refreshIfOutdated }, settings] = await Promise.all([import('@/pipeline/convert'), getSettings()]);
      c = await refreshIfOutdated(c, { langs: settings.ocr_langs });
    }
    setConv(c ?? null);
    if (c) {
      if (!c.template_id || !getTemplate(c.template_id)) {
        navigate(`/template/${c.id}`, { replace: true });
        return;
      }
      const doc = currentDoc(c);
      setBlocks(doc ? toEditor(doc) : []);
      setTemplateId(c.template_id);
      setLeftOutState({ sourceText: c.source_text, removed: c.removed });
      setSign(c.sign ?? { on: false, signature_id: null });
    }
    loaded.current = true;
  }, [id, navigate]);

  useEffect(() => {
    loaded.current = false;
    void load();
  }, [load]);

  useEffect(() => {
    if (!templateId) return;
    void signaturePosition.get(templateId).then((o) => setOffset(o ?? DEFAULT_OFFSET));
  }, [templateId]);

  const doc = useMemo(() => fromEditor(blocks), [blocks]);
  const report = useMemo(() => checkDocument(doc), [doc]);
  const coverage = useMemo(() => compareCoverage(leftOut.sourceText, docText(doc)), [leftOut.sourceText, doc]);
  const issuesByBlock = useMemo(() => {
    const map = new Map<number, Issue[]>();
    for (const issue of report.issues) map.set(issue.block, [...(map.get(issue.block) ?? []), issue]);
    return map;
  }, [report]);

  useEffect(() => {
    if (conv && !editReady) startTransition(() => setEditReady(true));
  }, [conv, editReady]);

  // Count the amber fields actually on screen: that is exactly what "jump to next" visits.
  useLayoutEffect(() => {
    setFlagCount(editRef.current ? editRef.current.querySelectorAll(FLAG_SELECTOR).length : 0);
  });

  // Autosave every edit, so nothing is lost if the phone locks or the tab is closed.
  const save = useMemo(
    () =>
      debounce((convId: string, next: EditorBlock[]) => {
        void db.conversions.update(convId, { edited_json: fromEditor(next), status: 'reviewed', output_pdf: null, output_pages: 0 });
      }, 500),
    [],
  );
  const update = useCallback(
    (fn: (prev: EditorBlock[]) => EditorBlock[]) => {
      setBlocks((prev) => {
        const next = fn(prev);
        if (id && loaded.current) save(id, next);
        return next;
      });
    },
    [id, save],
  );
  useEffect(() => () => save.flush(), [save]);

  // Re-render the preview 1 s after the last edit; at once when the template changes.
  useEffect(() => {
    if (!templateId || !conv) return;
    const key = renderKey(doc, templateId);
    if (render?.key === key) return;
    let cancelled = false;
    const immediate = renderedTemplate.current !== templateId;
    const timer = setTimeout(
      async () => {
        try {
          const result = await renderForTemplate(doc, templateId, conv.name);
          if (cancelled) return;
          renderedTemplate.current = templateId;
          setRender({ key, result });
          setRenderError(null);
        } catch (err) {
          if (!cancelled) setRenderError(friendlyError(err).message);
        }
      },
      immediate ? 0 : 1000,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, templateId, conv]);

  const changeBlock = (blockId: string, block: Block, low?: LowConfidence) => update((prev) => prev.map((b) => (b.id === blockId ? { ...b, block, low } : b)));
  const move = (index: number, dir: -1 | 1) =>
    update((prev) => {
      const to = index + dir;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  const setLeftOut = (next: { sourceText: string; removed: string[] }) => {
    setLeftOutState(next);
    if (id) void db.conversions.update(id, { source_text: next.sourceText, removed: next.removed });
  };
  /** Removes whole parts. A deliberate removal is remembered as "left out on purpose", not counted as lost content. */
  const removeParts = (indexes: number[], message: string) => {
    const before = { blocks, leftOut };
    const text = indexes
      .map((i) => blocks[i])
      .filter(Boolean)
      .map((g) => blockText(g.block))
      .join('\n');
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    update((prev) => prev.filter((_, i) => !indexes.includes(i)));
    setLeftOut({ sourceText: subtractTokens(leftOut.sourceText, text), removed: [...leftOut.removed, ...lines] });
    toast(message, {
      action: {
        label: 'Undo',
        onClick: () => {
          update(() => before.blocks);
          setLeftOut(before.leftOut);
        },
      },
    });
  };
  const insert = (index: number, block: Block) => update((prev) => [...prev.slice(0, index), { id: uid(), block, confidence: 1 }, ...prev.slice(index)]);

  const changeTemplate = async (next: string) => {
    if (!conv || next === templateId) return;
    setTemplateId(next);
    await Promise.all([db.conversions.update(conv.id, { template_id: next, output_pdf: null }), db.settings.put({ key: 'last_template', value: next })]);
  };

  const updateSign = (next: SignChoice) => {
    setSign(next);
    if (id) void db.conversions.update(id, { sign: next });
  };
  const selectedSignature = signatures?.find((s) => s.id === sign.signature_id) ?? signatures?.[0] ?? null;
  const signatureUrl = useObjectUrl(sign.on ? selectedSignature?.png : null);

  const toggleSign = (on: boolean) => {
    if (on && !signatures?.length) {
      setPanel('signature');
      return;
    }
    updateSign({ on, signature_id: on ? (selectedSignature?.id ?? null) : sign.signature_id });
  };

  const jumpToNext = () => {
    setTab('edit');
    requestAnimationFrame(() => {
      const list = Array.from(editRef.current?.querySelectorAll<HTMLElement>(FLAG_SELECTOR) ?? []);
      if (!list.length) return;
      jumpIndex.current = (jumpIndex.current + 1) % list.length;
      const el = list[jumpIndex.current];
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!window.matchMedia?.('(pointer: coarse)').matches) {
        const target = el.matches('input, textarea, [contenteditable]') ? el : el.closest<HTMLElement>('[contenteditable]');
        target?.focus({ preventScroll: true });
      }
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  };

  const finish = async () => {
    if (!conv || !def || !templateId) return;
    setPanel(null);
    setFinishing(true);
    save.flush();
    try {
      const rendered = await renderForTemplate(doc, templateId, conv.name);
      const pdf = await finalPdf(rendered, templateId, sign.on ? selectedSignature : null, conv.name);
      let warnings = conv.warnings.filter((w) => !w.startsWith('PDF check:'));
      try {
        const check = await verifyOutput(pdf, doc, def);
        if (check.warn) warnings = [...warnings, `PDF check: ${check.missingCount} words may not have printed (${check.missing.slice(0, 8).join(', ')}). Please look at the PDF carefully.`];
      } catch {
        // The read-back check is a bonus; a failure here must not block the download.
      }
      await db.conversions.update(conv.id, {
        edited_json: doc,
        output_pdf: new Blob([pdf as BlobPart], { type: 'application/pdf' }),
        output_pages: rendered.pages,
        output_name: outputFileName(def, doc, conv.created_at),
        status: 'rendered',
        sign,
        warnings,
        error: null,
      });
      navigate(`/done/${conv.id}`);
    } catch (err) {
      const message = friendlyError(err).message;
      await db.conversions.update(conv.id, { status: 'failed', error: message });
      toast.error(message);
    } finally {
      setFinishing(false);
    }
  };

  const onFinish = () => {
    if (flagCount > 0 || coverage.warn) setPanel('confirm');
    else void finish();
  };

  const reread = async (forceOcr: boolean) => {
    if (!conv) return;
    setRereading({ stage: 'reading', message: 'Reading the original again' });
    try {
      const [{ reExtract }, settings] = await Promise.all([import('@/pipeline/convert'), getSettings()]);
      await reExtract(conv, { langs: settings.ocr_langs, forceOcr, onProgress: setRereading });
      setRender(null);
      await load();
      toast.success(forceOcr ? 'Read again with the text scanner.' : 'Started again from the original.');
    } catch (err) {
      toast.error(friendlyError(err).message);
    } finally {
      setRereading(null);
    }
  };

  const markChecked = () => {
    update((prev) => prev.map((b) => (b.low ? { ...b, low: undefined } : b)));
    toast.success('All amber scan marks were cleared.');
  };

  if (conv === null) {
    return (
      <>
        <TopBar title="Review & sign" back="/" />
        <Page>
          <p className="py-10 text-center text-muted-foreground">This quotation is no longer on this device.</p>
        </Page>
      </>
    );
  }

  if (conv === undefined || !def) return <FullPageLoading label="Opening quotation" />;
  if (rereading) {
    return (
      <>
        <TopBar title="Reading again" subtitle={conv.name} />
        <Page>
          <Card className="mt-6 p-5">
            <p className="text-base font-semibold" aria-live="polite">
              {rereading.message}
            </p>
            <Progress className="mt-4" value={rereading.stage === 'ocr' && rereading.pages ? ((rereading.page ?? 1) - 1 + (rereading.progress ?? 0)) / rereading.pages : null} />
          </Card>
        </Page>
      </>
    );
  }

  const letterhead = senderLetterhead(blocks);
  const slot = render?.result.slot ?? null;
  const overlay =
    sign.on && selectedSignature && signatureUrl && slot
      ? {
          page: slot.page,
          node: (
            <SignatureOverlay
              slot={slot}
              offset={offset}
              image={{ url: signatureUrl, width: selectedSignature.width, height: selectedSignature.height }}
              onChange={(next) => {
                setOffset(next);
                void signaturePosition.set(def.id, next);
              }}
            />
          ),
        }
      : null;

  const banner = (
    <div className="mb-3 flex items-stretch gap-2" data-testid="check-banner" data-count={editReady ? flagCount : undefined}>
      {!editReady ? (
        <div className="flex min-h-12 flex-1 items-center gap-2.5 rounded-lg border bg-card px-3 text-muted-foreground">
          <Spinner className="size-4" />
          <span className="flex-1 text-[15px]">Checking the quotation</span>
        </div>
      ) : flagCount > 0 ? (
        <button
          type="button"
          onClick={jumpToNext}
          className="flex min-h-12 flex-1 items-center gap-2.5 rounded-lg border border-amber-300 bg-flag px-3 text-left text-flag-foreground"
          data-testid="jump-next"
        >
          <TriangleAlert className="size-5 shrink-0" />
          <span className="flex-1 text-[15px] font-semibold">
            {flagCount} {flagCount === 1 ? 'item needs' : 'items need'} a check
          </span>
          <span className="text-xs font-medium">Next</span>
          <ChevronRight className="size-4 shrink-0" />
        </button>
      ) : (
        <div className="flex min-h-12 flex-1 items-center gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-emerald-900">
          <CheckCircle2 className="size-5 shrink-0 text-emerald-700" />
          <span className="flex-1 text-[15px] font-medium">{report.rowsChecked + report.totalsChecked > 0 ? 'Amounts add up, nothing needs a check' : 'Nothing needs a check'}</span>
        </div>
      )}
      <Button variant="outline" className="h-auto min-h-12" onClick={() => setPanel('details')} aria-label="Check details">
        <ListChecks />
        <span className="max-sm:sr-only">Details</span>
      </Button>
    </div>
  );

  const previewPanel = (
    <div data-testid="preview-panel">
      <div className="mb-3">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Template</p>
        <div role="radiogroup" aria-label="Change template" className="flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === templateId}
              onClick={() => void changeTemplate(t.id)}
              className={cn(
                'flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium',
                t.id === templateId ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card',
              )}
              data-testid="template-chip"
            >
              {t.id === templateId ? <Check className="size-4" /> : null}
              {t.display_name}
            </button>
          ))}
        </div>
      </div>
      <SignPanel
        on={sign.on}
        signatures={signatures ?? []}
        selectedId={selectedSignature?.id ?? null}
        onToggle={toggleSign}
        onSelect={(sid) => updateSign({ on: true, signature_id: sid })}
        onNew={() => setPanel('signature')}
        onReset={() => {
          setOffset(DEFAULT_OFFSET);
          void signaturePosition.set(def.id, DEFAULT_OFFSET);
        }}
      />
      <div className="relative mt-3">
        {render ? (
          <PdfPages pdf={render.result.pdf} overlay={overlay} width="fit" placeholders={render.result.pages} />
        ) : renderError ? (
          <p role="alert" className="py-10 text-center text-sm text-destructive">
            {renderError}
          </p>
        ) : (
          <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
            <Spinner className="size-7 text-primary" />
            <p className="text-sm">Placing the quotation on {def.display_name}</p>
          </div>
        )}
        {render && render.key !== renderKey(doc, def.id) ? (
          <span className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-card/95 px-2.5 py-1 text-xs text-muted-foreground shadow" aria-live="polite">
            <Spinner className="size-3.5" /> Updating
          </span>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      <TopBar
        title="Review & sign"
        subtitle={conv.name}
        back={`/template/${conv.id}`}
        actions={
          <Menu>
            <MenuTrigger className="flex size-11 items-center justify-center rounded-md hover:bg-muted" aria-label="More options">
              <MoreVertical className="size-5" />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => navigate(`/template/${conv.id}`)}>
                <Stamp /> Choose another template
              </MenuItem>
              {flagCount > 0 ? (
                <MenuItem onSelect={markChecked}>
                  <ListChecks /> I have checked the scan marks
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem disabled={!conv.original_file || conv.original_type !== 'pdf'} onSelect={() => void reread(true)}>
                <ScanText /> Text looks wrong? Scan the pages
              </MenuItem>
              <MenuItem disabled={!conv.original_file} onSelect={() => void reread(false)}>
                <RotateCcw /> Start again from the original
              </MenuItem>
            </MenuContent>
          </Menu>
        }
      />

      <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 border-b bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
        <Segmented
          aria-label="Show"
          className="w-full"
          value={tab}
          onChange={setTab}
          options={[
            {
              value: 'preview',
              label: (
                <>
                  <Eye className="mr-1.5" /> Preview
                </>
              ),
            },
            {
              value: 'edit',
              label: (
                <>
                  <Pencil className="mr-1.5" /> Edit
                </>
              ),
            },
          ]}
        />
      </div>

      <main className="mx-auto w-full max-w-3xl px-4 pb-32 pt-4 lg:max-w-7xl">
        {banner}
        {letterheadHint && letterhead > 0 ? (
          <div className="mb-3 rounded-lg border border-primary/30 bg-secondary p-3" data-testid="letterhead-hint">
            <p className="text-[15px] font-medium">Remove the sender's letterhead?</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The first {letterhead === 1 ? 'part looks' : `${letterhead} parts look`} like the other company's name and address. The template already has yours.
            </p>
            <p className="mt-1.5 line-clamp-2 text-sm italic text-muted-foreground">
              {blocks
                .slice(0, letterhead)
                .map((b) => blockText(b.block))
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" onClick={() => removeParts(Array.from({ length: letterhead }, (_, i) => i), "Sender's letterhead removed.")} data-testid="remove-letterhead">
                <Trash2 /> Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLetterheadHint(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : null}
        {conv.warnings
          .filter((w) => !w.startsWith('PDF check:'))
          .map((w, i) => (
            <div key={i} role="note" className="mb-3 flex gap-2.5 rounded-lg border border-amber-300 bg-flag/60 p-3 text-sm text-flag-foreground">
              <CircleAlert className="mt-0.5 size-4.5 shrink-0" />
              <p>{w}</p>
            </div>
          ))}

        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-6">
          <section aria-label="Edit" className={cn('lg:order-1', tab !== 'edit' && 'max-lg:hidden')}>
            {editReady ? (
            <EditPanel
              ref={editRef}
              blocks={blocks}
              issuesByBlock={issuesByBlock}
              def={def}
              onChange={changeBlock}
              onMove={move}
              onRemove={(index) => removeParts([index], 'Part removed.')}
              onAdd={(at) => {
                setAddAt(at);
                setPanel('add');
              }}
            />
            ) : (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Spinner /> Opening the parts
              </div>
            )}
          </section>
          <section aria-label="Preview" className={cn('lg:order-2', tab !== 'preview' && 'max-lg:hidden')}>
            <div className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1" data-testid="preview-scroll">
              {previewPanel}
            </div>
          </section>
        </div>
      </main>

      <BottomBar className="lg:max-w-7xl">
        <Button size="lg" className="flex-1" onClick={onFinish} disabled={finishing || !render} data-testid="finish">
          {finishing ? <Spinner /> : <Check />} {finishing ? 'Making the PDF' : 'Finish'}
        </Button>
      </BottomBar>

      <Sheet open={panel === 'details'} onOpenChange={(o) => !o && setPanel(null)}>
        <SheetContent title="Checks" description="Nothing is ever changed automatically. These checks only point at things to look at.">
          <div className="flex flex-col gap-4 text-sm">
            <section>
              <h3 className="font-semibold">Content</h3>
              <p className="mt-0.5 text-muted-foreground" data-testid="coverage-summary">
                {coverage.missingCount === 0
                  ? `All ${coverage.sourceCount} words and numbers of the original are here.`
                  : `${coverage.missingCount} of ${coverage.sourceCount} words from the original are not in the text (${(coverage.missingPct * 100).toFixed(1)}%).`}
              </p>
              {coverage.missing.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5" data-testid="missing-tokens">
                  {coverage.missing.slice(0, 120).map((t, i) => (
                    <span key={i} className="rounded bg-flag px-2 py-0.5 text-flag-foreground">
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </section>
            <section>
              <h3 className="font-semibold">Amounts</h3>
              <p className="mt-0.5 text-muted-foreground">
                {report.rowsChecked} rows and {report.totalsChecked} totals were recalculated.{' '}
                {report.issues.length ? `${report.issues.length} do not add up:` : 'All add up.'}
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {report.issues.map((issue, i) => (
                  <li key={i} className="flex gap-2 rounded-md bg-flag/70 px-3 py-2 text-flag-foreground">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {issue.message}
                  </li>
                ))}
              </ul>
            </section>
            {leftOut.removed.length ? (
              <section>
                <h3 className="font-semibold">Left out on purpose</h3>
                <p className="mt-0.5 text-muted-foreground">The sender's own letterhead, page numbers, repeated table headings and parts you removed.</p>
                <ul className="mt-2 flex flex-col gap-1.5" data-testid="removed-lines">
                  {[...new Set(leftOut.removed)].map((line, i) => (
                    <li key={i} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
                      <span className="min-w-0 flex-1 break-words">{line}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          insert(0, { type: 'paragraph', runs: [{ text: line }], align: 'left' });
                          setLeftOut({ sourceText: leftOut.sourceText, removed: leftOut.removed.filter((l) => l !== line) });
                          toast.success('Added back at the top.');
                        }}
                      >
                        Put back
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={panel === 'add'} onOpenChange={(o) => !o && setPanel(null)}>
        <SheetContent title="Add a part">
          <ul className="flex flex-col">
            {ADDABLE.map(({ type, hint }) => {
              const Icon = BLOCK_ICON[type];
              return (
                <li key={type}>
                  <button
                    type="button"
                    className="flex min-h-14 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-muted"
                    onClick={() => {
                      insert(addAt, newBlock(type));
                      setPanel(null);
                    }}
                  >
                    <span className="flex size-10 items-center justify-center rounded-md bg-secondary text-primary">
                      <Icon className="size-5" />
                    </span>
                    <span>
                      <span className="block font-medium">{BLOCK_LABEL[type]}</span>
                      <span className="block text-sm text-muted-foreground">{hint}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>

      <Sheet open={panel === 'confirm'} onOpenChange={(o) => !o && setPanel(null)}>
        <SheetContent title="Before you finish" description="Some things still need a look. Go back, or make the PDF as it is.">
          <ul className="mb-4 flex flex-col gap-2 text-sm">
            {flagCount > 0 ? (
              <li className="flex gap-2 rounded-md bg-flag/70 px-3 py-2 text-flag-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {flagCount} {flagCount === 1 ? 'item needs' : 'items need'} a check (amber).
              </li>
            ) : null}
            {coverage.warn ? (
              <li className="flex gap-2 rounded-md bg-flag/70 px-3 py-2 text-flag-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {coverage.missingCount} words from the original are missing ({(coverage.missingPct * 100).toFixed(1)}%).
              </li>
            ) : null}
          </ul>
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              variant="outline"
              onClick={() => {
                setPanel(null);
                if (flagCount > 0) jumpToNext();
              }}
            >
              Go back and check
            </Button>
            <Button size="lg" onClick={() => void finish()} data-testid="finish-anyway">
              Make the PDF anyway
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <SignatureSheet
        open={panel === 'signature'}
        onOpenChange={(o) => setPanel(o ? 'signature' : null)}
        existingCount={signatures?.length ?? 0}
        onSaved={(sig) => updateSign({ on: true, signature_id: sig.id })}
      />
    </>
  );
}
