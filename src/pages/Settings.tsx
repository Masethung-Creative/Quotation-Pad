import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useLiveQuery } from 'dexie-react-hooks';
import { toast } from 'sonner';
import { CloudDownload, HardDrive, PenLine, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Page, Spinner, TopBar, useObjectUrl } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/misc';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { db, getSettings, purgeOldOriginals, saveSetting, storageEstimate, type SavedSignature } from '@/db/db';
import { OCR_LANGS, type OcrLang } from '@/extract/ocr';
import { ocrReadyOffline } from '@/extract/ocrWarm';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CHECKERBOARD, SignatureSheet } from '@/signature/SignatureSheet';
import { TEMPLATES } from '@/templates';

const retentionSchema = z.object({
  retention_days: z.number({ error: 'Enter a number of days' }).int('Use whole days').min(0, 'Cannot be negative').max(3650, 'At most 3650 days'),
});
type RetentionForm = z.infer<typeof retentionSchema>;

function SignatureRow({ sig }: { sig: SavedSignature }) {
  const url = useObjectUrl(sig.png);
  const [label, setLabel] = useState(sig.label);
  return (
    <li className="flex items-center gap-3 border-b py-2 last:border-b-0">
      <span className={cn('flex h-12 w-28 shrink-0 items-center justify-center overflow-hidden rounded border', CHECKERBOARD)}>{url ? <img src={url} alt="" className="max-h-11 max-w-[6.5rem]" /> : null}</span>
      <Input
        aria-label="Signature name"
        value={label}
        maxLength={40}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() && label !== sig.label && void db.signatures.update(sig.id, { label: label.trim() })}
        className="min-w-0 flex-1"
      />
      <button
        type="button"
        aria-label={`Delete ${sig.label}`}
        onClick={async () => {
          await db.signatures.delete(sig.id);
          toast.success('Signature deleted from this device.');
        }}
        className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
      >
        <Trash2 className="size-4.5" />
      </button>
    </li>
  );
}

export default function Settings() {
  const [langs, setLangs] = useState<OcrLang[]>(['eng']);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [counts, setCounts] = useState({ conversions: 0, originals: 0 });
  const [warming, setWarming] = useState<{ done: number; total: number } | null>(null);
  const [offlineOcr, setOfflineOcr] = useState<boolean | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [newSignature, setNewSignature] = useState(false);
  const signatures = useLiveQuery(() => db.signatures.orderBy('created_at').toArray(), []);

  const form = useForm<RetentionForm>({ resolver: zodResolver(retentionSchema), defaultValues: { retention_days: 90 }, mode: 'onChange' });

  const refresh = async () => {
    setUsage(await storageEstimate());
    const conversions = await db.conversions.toArray();
    setCounts({ conversions: conversions.length, originals: conversions.filter((c) => c.original_file).length });
  };

  useEffect(() => {
    void getSettings().then((s) => {
      setLangs(s.ocr_langs);
      form.reset({ retention_days: s.retention_days });
      void ocrReadyOffline(s.ocr_langs).then(setOfflineOcr);
    });
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveRetention = form.handleSubmit(async ({ retention_days }) => {
    await saveSetting('retention_days', retention_days);
    const removed = await purgeOldOriginals();
    await refresh();
    toast.success(removed ? `Saved. ${removed} old original${removed === 1 ? '' : 's'} removed.` : 'Saved.');
  });

  const toggleLang = (code: OcrLang) => {
    if (code === 'eng') return;
    const next = langs.includes(code) ? langs.filter((l) => l !== code) : [...langs, code];
    setLangs(next);
    void saveSetting('ocr_langs', next);
    void ocrReadyOffline(next).then(setOfflineOcr);
  };

  const warm = async () => {
    setWarming({ done: 0, total: 1 });
    try {
      const { warmOcrAssets } = await import('@/extract/ocr');
      await warmOcrAssets(langs, (done, total) => setWarming({ done, total }));
      setOfflineOcr(true);
      toast.success('The text scanner is saved on this device. Scans and photos now work offline.');
    } catch {
      toast.error('The download did not finish. Check your connection and try again.');
    } finally {
      setWarming(null);
    }
  };

  const deleteOriginals = async () => {
    const all = await db.conversions.toArray();
    await Promise.all(all.filter((c) => c.original_file).map((c) => db.conversions.update(c.id, { original_file: null })));
    await refresh();
    toast.success('Original uploads removed. Your finished PDFs are kept.');
  };

  const wipe = async () => {
    await db.transaction('rw', db.conversions, db.signatures, db.settings, async () => {
      await db.conversions.clear();
      await db.signatures.clear();
      await db.settings.clear();
    });
    setConfirmWipe(false);
    await refresh();
    toast.success('Everything was deleted from this device.');
  };

  return (
    <>
      <TopBar title="Settings" back="/" />
      <Page className="flex flex-col gap-4">
        <Card className="p-4">
          <h2 className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-5 text-success" /> Privacy
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Quotation Pad works entirely on this device. Quotations and signatures are never uploaded, and there is no tracking or analytics.
          </p>
        </Card>

        <Card className="p-4">
          <h2 className="flex items-center gap-2 font-semibold">
            <PenLine className="size-5 text-muted-foreground" /> Signatures
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Kept only on this device. Add one by drawing with your finger or from a photo.</p>
          {signatures && signatures.length ? (
            <ul className="mt-2" data-testid="signature-list">
              {signatures.map((sig) => (
                <SignatureRow key={sig.id} sig={sig} />
              ))}
            </ul>
          ) : null}
          <Button variant="outline" className="mt-3 w-full" onClick={() => setNewSignature(true)}>
            <Plus /> Add a signature
          </Button>
        </Card>

        <Card className="p-4">
          <h2 className="font-semibold">Scans and photos</h2>
          <p className="mt-1 text-sm text-muted-foreground">Languages to read in scanned PDFs and photos. Turn on only what your quotations contain: fewer languages read faster.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {OCR_LANGS.map((l) => {
              const on = langs.includes(l.code);
              return (
                <button
                  key={l.code}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  disabled={l.code === 'eng'}
                  onClick={() => toggleLang(l.code)}
                  className={cn('flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium disabled:cursor-default', on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card')}
                >
                  {l.native}
                  {l.native !== l.label ? <span className={cn('text-xs', on ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{l.label}</span> : null}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-sm" data-testid="ocr-offline-status">
            {offlineOcr === null ? '' : offlineOcr ? 'Ready to read scans and photos offline.' : 'Not saved for offline use yet.'}
          </p>
          <Button variant="outline" className="mt-2 w-full" onClick={() => void warm()} disabled={warming !== null}>
            {warming ? <Spinner /> : <CloudDownload />}
            {warming ? `Downloading ${warming.done} of ${warming.total}` : 'Download the text scanner for offline use'}
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">About 7 MB for English, plus about 1.5 MB per extra language. This happens by itself after the first visit unless Data Saver is on.</p>
        </Card>

        <Card className="p-4">
          <h2 className="flex items-center gap-2 font-semibold">
            <HardDrive className="size-5 text-muted-foreground" /> Storage on this device
          </h2>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="storage-summary">
            {counts.conversions} quotation{counts.conversions === 1 ? '' : 's'} ({counts.originals} with the original upload)
            {usage ? `. Using ${formatBytes(usage.usage)}.` : '.'}
          </p>

          <form onSubmit={saveRetention} className="mt-4" noValidate>
            <Label htmlFor="retention">Delete original uploads after (days)</Label>
            <div className="mt-1.5 flex gap-2">
              <Input id="retention" inputMode="numeric" className="max-w-32 tabular-nums" aria-invalid={!!form.formState.errors.retention_days} {...form.register('retention_days', { valueAsNumber: true })} />
              <Button type="submit" variant="outline" disabled={!form.formState.isValid}>
                Save
              </Button>
            </div>
            {form.formState.errors.retention_days ? (
              <p className="mt-1 text-xs text-destructive">{form.formState.errors.retention_days.message}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">The file you uploaded is removed after this many days to save space. The finished PDF stays. Use 0 to keep originals forever.</p>
            )}
          </form>

          <div className="mt-4 flex flex-col gap-2">
            <Button variant="outline" onClick={() => void deleteOriginals()} disabled={counts.originals === 0}>
              <Trash2 /> Remove all original uploads now
            </Button>
            <Button variant="ghost" className="text-destructive" onClick={() => setConfirmWipe(true)}>
              <Trash2 /> Delete everything
            </Button>
          </div>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Quotation Pad {__APP_VERSION__} · {TEMPLATES.length} company templates · Free and open source
        </p>
      </Page>

      <SignatureSheet open={newSignature} onOpenChange={setNewSignature} existingCount={signatures?.length ?? 0} onSaved={() => undefined} />

      <Sheet open={confirmWipe} onOpenChange={setConfirmWipe}>
        <SheetContent title="Delete everything?" description="All quotations, signatures and settings will be removed from this device. This cannot be undone.">
          <div className="flex flex-col gap-2 pt-1">
            <Button variant="destructive" size="lg" onClick={() => void wipe()}>
              <Trash2 /> Delete everything
            </Button>
            <Button variant="outline" size="lg" onClick={() => setConfirmWipe(false)}>
              Cancel
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
