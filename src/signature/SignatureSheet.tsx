import { useEffect, useRef, useState } from 'react';
import SignaturePad from 'signature_pad';
import { toast } from 'sonner';
import { Camera, Eraser, ImageUp, PenLine } from 'lucide-react';
import { Spinner } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, Segmented } from '@/components/ui/misc';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { db, type SavedSignature } from '@/db/db';
import { friendlyError } from '@/lib/errors';
import { uid } from '@/lib/utils';
import { canvasToInk, inkToPng, photoToInk, type SignaturePng } from './image';
import { INK_RGB, NoSignatureError, recolour, type InkColour, type InkImage } from './process';

const inkCss = (ink: InkColour) => `rgb(${INK_RGB[ink].join(',')})`;

/** Checkerboard behind previews, so a transparent background is visible as such. */
export const CHECKERBOARD =
  'bg-[length:16px_16px] bg-[linear-gradient(45deg,#eceae4_25%,transparent_25%),linear-gradient(-45deg,#eceae4_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eceae4_75%),linear-gradient(-45deg,transparent_75%,#eceae4_75%)] bg-[position:0_0,0_8px,8px_-8px,-8px_0]';

function DrawPad({ ink, onReady }: { ink: InkColour; onReady: (pad: SignaturePad | null, canvas: HTMLCanvasElement | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const data = padRef.current?.toData();
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext('2d')?.scale(ratio, ratio);
      padRef.current?.clear();
      if (data?.length) padRef.current?.fromData(data);
    };
    const pad = new SignaturePad(canvas, { penColor: inkCss(ink), minWidth: 0.9, maxWidth: 2.6, backgroundColor: 'rgba(0,0,0,0)' });
    pad.addEventListener('endStroke', () => setEmpty(pad.isEmpty()));
    padRef.current = pad;
    resize();
    onReady(pad, canvas);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      pad.off();
      padRef.current = null;
      onReady(null, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const pad = padRef.current;
    if (!pad) return;
    pad.penColor = inkCss(ink);
    // Redraw what is there in the new colour.
    const data = pad.toData().map((group) => ({ ...group, penColor: inkCss(ink) }));
    pad.clear();
    pad.fromData(data);
  }, [ink]);

  return (
    <div>
      <div className="relative overflow-hidden rounded-lg border-2 border-dashed border-input bg-white">
        <canvas ref={canvasRef} className="block h-44 w-full touch-none" aria-label="Signature drawing area" data-testid="signature-canvas" />
        <div className="pointer-events-none absolute inset-x-6 bottom-9 border-b border-muted-foreground/40" />
        {empty ? <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">Sign here with your finger</p> : null}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1"
        onClick={() => {
          padRef.current?.clear();
          setEmpty(true);
        }}
      >
        <Eraser /> Clear
      </Button>
    </div>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (signature: SavedSignature) => void;
  existingCount: number;
}

export function SignatureSheet({ open, onOpenChange, onSaved, existingCount }: Props) {
  const [mode, setMode] = useState<'draw' | 'photo'>('draw');
  const [ink, setInk] = useState<InkColour>('blue');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<{ ink: InkImage; png: SignaturePng } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const pad = useRef<{ pad: SignaturePad | null; canvas: HTMLCanvasElement | null }>({ pad: null, canvas: null });
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(existingCount ? `Signature ${existingCount + 1}` : 'My signature');
    setPhoto(null);
    setPhotoError(null);
  }, [open, existingCount]);

  useEffect(() => () => (photo ? URL.revokeObjectURL(photo.png.url) : undefined), [photo]);

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setPhotoError(null);
    try {
      const inkImage = await photoToInk(file, ink);
      setPhoto({ ink: inkImage, png: await inkToPng(inkImage) });
    } catch (err) {
      setPhoto(null);
      setPhotoError(err instanceof NoSignatureError ? err.message : friendlyError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const changeInk = async (next: InkColour) => {
    setInk(next);
    if (photo) {
      const inkImage = recolour(photo.ink, next);
      setPhoto({ ink: inkImage, png: await inkToPng(inkImage) });
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      let png: SignaturePng;
      if (mode === 'draw') {
        if (!pad.current.pad || !pad.current.canvas || pad.current.pad.isEmpty()) {
          toast.error('Draw your signature first.');
          return;
        }
        png = await inkToPng(canvasToInk(pad.current.canvas, ink));
      } else {
        if (!photo) {
          toast.error('Choose a photo of your signature first.');
          return;
        }
        png = photo.png;
      }
      const record: SavedSignature = {
        id: uid(),
        label: label.trim() || 'Signature',
        png: png.blob,
        width: png.width,
        height: png.height,
        ink,
        source: mode === 'draw' ? 'drawn' : 'photo',
        created_at: Date.now(),
      };
      await db.signatures.add(record);
      toast.success('Signature saved on this device.');
      onSaved(record);
      onOpenChange(false);
    } catch (err) {
      toast.error(friendlyError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="New signature" description="Saved only on this device. It is never uploaded.">
        <div className="flex flex-col gap-4">
          <Segmented
            aria-label="How to add the signature"
            className="w-full"
            value={mode}
            onChange={setMode}
            options={[
              {
                value: 'draw',
                label: (
                  <>
                    <PenLine className="mr-1.5" /> Draw
                  </>
                ),
              },
              {
                value: 'photo',
                label: (
                  <>
                    <Camera className="mr-1.5" /> Photo
                  </>
                ),
              },
            ]}
          />

          {mode === 'draw' ? (
            <DrawPad ink={ink} onReady={(p, c) => (pad.current = { pad: p, canvas: c })} />
          ) : (
            <div>
              <input ref={fileInput} type="file" accept="image/*,.heic,.heif" className="sr-only" tabIndex={-1} data-testid="signature-photo" onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
              <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} onChange={(e) => { void pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
              <div className={`flex min-h-44 items-center justify-center overflow-hidden rounded-lg border ${CHECKERBOARD}`}>
                {busy ? (
                  <Spinner className="text-primary" />
                ) : photo ? (
                  <img src={photo.png.url} alt="Your signature, background removed" className="max-h-40 max-w-full" data-testid="signature-photo-preview" />
                ) : (
                  <p className="max-w-64 px-4 text-center text-sm text-muted-foreground">Sign on plain white paper with a dark pen, then take a close, well-lit photo.</p>
                )}
              </div>
              {photoError ? (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {photoError}
                </p>
              ) : null}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => cameraInput.current?.click()} disabled={busy}>
                  <Camera /> Take photo
                </Button>
                <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy}>
                  <ImageUp /> Choose photo
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-medium">Ink colour</span>
            <Segmented
              aria-label="Ink colour"
              value={ink}
              onChange={(v) => void changeInk(v)}
              options={[
                { value: 'blue', label: <span style={{ color: inkCss('blue') }}>Dark blue</span> },
                { value: 'black', label: <span style={{ color: inkCss('black') }}>Black</span> },
              ]}
            />
          </div>

          <div>
            <Label htmlFor="sig-label">Name for this signature</Label>
            <Input id="sig-label" className="mt-1.5" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
          </div>

          <Button size="lg" onClick={() => void save()} disabled={busy} data-testid="save-signature">
            {busy ? <Spinner /> : null} Save signature
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
