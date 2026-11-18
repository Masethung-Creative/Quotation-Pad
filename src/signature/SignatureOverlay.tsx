import { useEffect, useRef, useState } from 'react';
import { PAGE_PT, type SignatureSlot } from '@/render/docdef';
import { fitImage, offsetFromBox, signatureBox, type SignatureOffset } from '@/render/signature';
import { cn } from '@/lib/utils';

/**
 * The signature drawn over the preview page, exactly where it will be printed.
 * Drag with one finger (or the mouse) to move it, pinch with two fingers (or use the
 * corner handle / + and - keys) to resize. The new position is saved per template.
 */

interface Props {
  slot: SignatureSlot;
  offset: SignatureOffset;
  image: { url: string; width: number; height: number };
  onChange: (offset: SignatureOffset) => void;
}


const [PAGE_W, PAGE_H] = PAGE_PT.A4;
const pct = (v: number, of: number) => `${(v / of) * 100}%`;

interface Gesture {
  pointers: Map<number, { x: number; y: number }>;
  start: { box: { x: number; y: number; w: number; h: number }; points: { x: number; y: number }[] };
  mode: 'move' | 'resize';
}

export function SignatureOverlay({ slot, offset, image, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<SignatureOffset>(offset);
  const liveRef = useRef(live);
  liveRef.current = live;
  const gesture = useRef<Gesture | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => setLive(offset), [offset]);

  const box = signatureBox(slot, live);
  const img = fitImage(box, image.width, image.height);

  const ptPerPx = () => {
    const rect = host.current?.getBoundingClientRect();
    return rect && rect.width ? PAGE_W / rect.width : 1;
  };

  const begin = (mode: Gesture['mode']) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const g = gesture.current ?? { pointers: new Map(), start: { box, points: [] }, mode };
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    g.mode = mode;
    const current = signatureBox(slot, liveRef.current);
    g.start = { box: current, points: [...g.pointers.values()].map((p) => ({ ...p })) };
    gesture.current = g;
    setActive(true);
  };

  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || !g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const k = ptPerPx();
    const now = [...g.pointers.values()];
    const { box: b0, points: p0 } = g.start;
    let next: { x: number; y: number; w: number };
    if (now.length >= 2 && p0.length >= 2) {
      // Pinch: scale around the midpoint of the two fingers.
      const d0 = Math.hypot(p0[0].x - p0[1].x, p0[0].y - p0[1].y) || 1;
      const d1 = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y);
      const w = b0.w * (d1 / d0);
      const h = (w * slot.h) / slot.w;
      const cx = b0.x + b0.w / 2 + (((now[0].x + now[1].x) / 2 - (p0[0].x + p0[1].x) / 2) * k);
      const cy = b0.y + b0.h / 2 + (((now[0].y + now[1].y) / 2 - (p0[0].y + p0[1].y) / 2) * k);
      next = { x: cx - w / 2, y: cy - h / 2, w };
    } else if (g.mode === 'resize') {
      const w = b0.w + (now[0].x - p0[0].x) * k;
      next = { x: b0.x, y: b0.y + b0.h - (w * slot.h) / slot.w, w };
    } else {
      next = { x: b0.x + (now[0].x - p0[0].x) * k, y: b0.y + (now[0].y - p0[0].y) * k, w: b0.w };
    }
    setLive(offsetFromBox(slot, next));
  };

  const end = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size > 0) {
      // One finger lifted after a pinch: continue as a move from here.
      g.start = { box: signatureBox(slot, liveRef.current), points: [...g.pointers.values()].map((p) => ({ ...p })) };
      return;
    }
    gesture.current = null;
    setActive(false);
    onChange(liveRef.current);
  };

  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 5 : 1;
    let next: SignatureOffset | null = null;
    if (e.key === 'ArrowLeft') next = { ...live, dx: live.dx - step };
    if (e.key === 'ArrowRight') next = { ...live, dx: live.dx + step };
    if (e.key === 'ArrowUp') next = { ...live, dy: live.dy - step };
    if (e.key === 'ArrowDown') next = { ...live, dy: live.dy + step };
    if (e.key === '+' || e.key === '=') next = { ...live, scale: live.scale + 0.1 };
    if (e.key === '-') next = { ...live, scale: live.scale - 0.1 };
    if (!next) return;
    e.preventDefault();
    // Normalise through the clamping maths so the box never leaves the safe area.
    const b = signatureBox(slot, next);
    const normalised = offsetFromBox(slot, b);
    setLive(normalised);
    onChange(normalised);
  };

  return (
    <div ref={host} className="pointer-events-none absolute inset-0" data-testid="signature-overlay">
      <img
        src={image.url}
        alt=""
        draggable={false}
        className="pointer-events-none absolute select-none"
        style={{ left: pct(img.x, PAGE_W), top: pct(img.y, PAGE_H), width: pct(img.w, PAGE_W), height: pct(img.h, PAGE_H) }}
      />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Signature position. Drag to move, pinch or use plus and minus to resize."
        aria-valuetext={`${Math.round(live.scale * 100)}% size`}
        aria-valuenow={Math.round(live.scale * 100)}
        aria-valuemin={50}
        aria-valuemax={250}
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={key}
        className={cn(
          'pointer-events-auto absolute cursor-move touch-none rounded-sm outline-2 outline-offset-2 outline-primary/70 outline-dashed focus-visible:outline-solid',
          active && 'outline-solid',
        )}
        style={{ left: pct(box.x, PAGE_W), top: pct(box.y, PAGE_H), width: pct(box.w, PAGE_W), height: pct(box.h, PAGE_H) }}
        data-testid="signature-box"
      >
        {/* Resize handle on the top-right corner, so it never hides the signatory's name below. */}
        <span
          aria-hidden="true"
          onPointerDown={begin('resize')}
          className="absolute -right-4 -top-4 flex size-8 cursor-nesw-resize touch-none items-center justify-center"
        >
          <span className="size-4 rounded-full bg-primary shadow ring-2 ring-white" />
        </span>
      </div>
    </div>
  );
}


