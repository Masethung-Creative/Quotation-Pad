import { Plus, RotateCcw } from 'lucide-react';
import { useObjectUrl } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/misc';
import type { SavedSignature } from '@/db/db';
import { cn } from '@/lib/utils';
import { CHECKERBOARD } from './SignatureSheet';

function Chip({ sig, selected, onSelect }: { sig: SavedSignature; selected: boolean; onSelect: () => void }) {
  const url = useObjectUrl(sig.png);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn('flex min-h-11 shrink-0 flex-col items-center gap-1 rounded-lg border-2 bg-card p-1.5', selected ? 'border-primary' : 'border-transparent ring-1 ring-border')}
    >
      <span className={cn('flex h-10 w-24 items-center justify-center overflow-hidden rounded', CHECKERBOARD)}>{url ? <img src={url} alt="" className="max-h-9 max-w-[5.5rem]" /> : null}</span>
      <span className="max-w-24 truncate text-xs font-medium">{sig.label}</span>
    </button>
  );
}

interface Props {
  on: boolean;
  signatures: SavedSignature[];
  selectedId: string | null;
  onToggle: (on: boolean) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onReset: () => void;
}

/** "Add signature" toggle (off by default) and the choice of saved signature. */
export function SignPanel({ on, signatures, selectedId, onToggle, onSelect, onNew, onReset }: Props) {
  return (
    <div className="rounded-lg border bg-card p-3" data-testid="sign-panel">
      <label className="flex min-h-11 items-center justify-between gap-3">
        <span className="text-[15px] font-semibold">Add signature</span>
        <Switch checked={on} onCheckedChange={onToggle} aria-label="Add signature" data-testid="sign-toggle" />
      </label>
      {on ? (
        <div className="mt-2">
          <div role="radiogroup" aria-label="Saved signatures" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {signatures.map((sig) => (
              <Chip key={sig.id} sig={sig} selected={sig.id === selectedId} onSelect={() => onSelect(sig.id)} />
            ))}
            <button type="button" onClick={onNew} className="flex min-h-11 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input px-4 text-sm font-medium text-muted-foreground hover:text-foreground">
              <Plus className="size-5" /> New
            </button>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Drag the signature on the page to move it. Pinch, or drag its corner, to resize.</p>
            <Button variant="ghost" size="sm" onClick={onReset}>
              <RotateCcw /> Reset position
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
