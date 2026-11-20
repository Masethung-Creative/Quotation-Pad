import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Columns3, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { formatIndian, looksNumeric, parseAmount } from '@/lib/format';
import { columnKinds } from '@/render/body';
import type { TableBlock } from '@/schema/canonical';
import { detectColumns } from '@/validate/totals';
import { cn } from '@/lib/utils';

/**
 * Phone / tablet editing of a table: a short list of items (description + amount), and a
 * full-screen form with one large labelled field per column for the item you tap. No
 * sideways scrolling, no pinch-zoom; number fields open the number keypad.
 */

export interface ItemListProps {
  block: TableBlock;
  /** Cells that need a look, as "row:col" (row -1 = heading). */
  flagged: Set<string>;
  /** Messages from the totals checker, by "row:col". */
  messages: Map<string, string>;
  onEdit: (row: number, col: number, value: string) => void;
  onInsertRow: (at: number) => void;
  onDeleteRow: (at: number) => void;
  onInsertCol: (at: number) => void;
  onDeleteCol: (at: number) => void;
}

/** The column that best describes an item: the text column with the most text. */
export function describingColumn(block: TableBlock): number {
  const kinds = columnKinds(block);
  let best = -1;
  let bestLen = -1;
  kinds.forEach((k, c) => {
    if (k !== 'text') return;
    const len = block.rows.reduce((n, r) => n + (r[c] ?? '').length, 0) + 1;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  });
  return best >= 0 ? best : 0;
}

/** The column whose value is shown on the right of each item: the amount. */
export function amountColumnOf(block: TableBlock): number {
  const cols = detectColumns(block);
  if (cols.amounts.length) return cols.amounts[cols.amounts.length - 1];
  const kinds = columnKinds(block);
  for (let c = kinds.length - 1; c >= 0; c--) if (kinds[c] === 'number') return c;
  return -1;
}

/** Qty x Rate compared with the Amount of one row (only when all three are numbers). */
export function rowCheck(block: TableBlock, row: number): { ok: boolean; text: string } | null {
  const cols = detectColumns(block);
  const amountCol = cols.amounts[cols.amounts.length - 1];
  if (cols.qty < 0 || cols.rate < 0 || amountCol === undefined) return null;
  const r = block.rows[row] ?? [];
  const qty = parseAmount(r[cols.qty]);
  const rate = parseAmount(r[cols.rate]);
  const amount = parseAmount(r[amountCol]);
  if (qty === null || rate === null || amount === null) return null;
  // Discount / tax columns change the amount: no simple check then.
  if (cols.discPct >= 0 || cols.taxPct >= 0) return null;
  const expected = Math.round(qty * rate * 100) / 100;
  const ok = Math.abs(expected - amount) < 0.01;
  return {
    ok,
    text: `${r[cols.qty].trim()} × ${r[cols.rate].trim()} = ${formatIndian(expected)}${ok ? '' : ` (written: ${r[amountCol].trim()})`}`,
  };
}

const isNumberColumn = (block: TableBlock, c: number) => {
  const values = block.rows.map((r) => (r[c] ?? '').trim()).filter(Boolean);
  return values.length > 0 && values.every((v) => looksNumeric(v));
};

export function ItemList({ block, flagged, messages, onEdit, onInsertRow, onDeleteRow, onInsertCol, onDeleteCol }: ItemListProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const firstField = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const desc = describingColumn(block);
  const amount = amountColumnOf(block);
  const n = block.columns.length;
  const label = (c: number) => block.columns[c]?.trim() || `Column ${c + 1}`;
  const kinds = columnKinds(block);
  // Qty x Rate = Amount for the open item (shown once, under the fields).
  const check = open !== null && block.rows[open] ? rowCheck(block, open) : null;

  // A row that was deleted while open: close the form.
  useEffect(() => {
    if (open !== null && open >= block.rows.length) setOpen(block.rows.length ? block.rows.length - 1 : null);
  }, [open, block.rows.length]);

  const addItem = () => {
    onInsertRow(block.rows.length);
    setOpen(block.rows.length);
  };

  return (
    <div data-testid="item-list">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {block.rows.length} {block.rows.length === 1 ? 'item' : 'items'} · tap one to edit
        </p>
        <Button variant="ghost" size="sm" onClick={() => setColumnsOpen(true)} data-testid="edit-columns">
          <Columns3 /> Columns
        </Button>
      </div>

      <ol className="divide-y overflow-hidden rounded-lg border bg-card">
        {block.rows.map((row, r) => {
          const rowFlags = row.map((_, c) => c).filter((c) => flagged.has(`${r}:${c}`) || messages.has(`${r}:${c}`));
          const title = (row[desc] ?? '').trim() || row.find((v) => v.trim() && !looksNumeric(v))?.trim() || `Item ${r + 1}`;
          return (
            <li key={r}>
              <button
                type="button"
                onClick={() => setOpen(r)}
                data-testid="item-row"
                className="flex min-h-14 w-full items-start gap-3 px-3 py-2.5 text-left active:bg-muted"
                aria-label={`Item ${r + 1}: ${title}. Tap to edit`}
              >
                <span className="mt-0.5 w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{r + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-base leading-snug">{title}</span>
                  {rowFlags.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {rowFlags.map((c) => (
                        <span key={c} data-flag="true" className="rounded bg-flag px-1.5 py-0.5 text-xs font-medium text-flag-foreground">
                          {label(c)}: {(row[c] ?? '').trim() || 'empty'}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                {amount >= 0 && <span className="shrink-0 pt-0.5 text-base tabular-nums">{(row[amount] ?? '').trim()}</span>}
                <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ol>
      <Button variant="outline" className="mt-2 w-full" onClick={addItem} data-testid="add-item">
        <Plus /> Add item
      </Button>

      {/* One item, one large field per column. */}
      <Sheet open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        {open !== null && block.rows[open] && (
          <SheetContent
            title={`Item ${open + 1} of ${block.rows.length}`}
            className="max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:rounded-none"
            onOpenAutoFocus={(e) => {
              // Do not pop the keyboard up straight away; let the user see the whole item first.
              e.preventDefault();
              firstField.current = null;
            }}
          >
            <div className="flex flex-col gap-4 pb-2" data-testid="item-form">
              <div className="grid grid-cols-2 gap-x-3 gap-y-4">
              {block.columns.map((_, c) => {
                const key = `${open}:${c}`;
                const value = block.rows[open][c] ?? '';
                const amber = flagged.has(key) || messages.has(key);
                const numeric = isNumberColumn(block, c) || /\b(qty|quantity|rate|price|amount|amt|total|value|nos)\b/i.test(label(c));
                // Short fields (numbers, codes) two per row; text across the full width.
                const half = numeric || kinds[c] === 'short';
                const common = {
                  id: `item-${open}-${c}`,
                  value,
                  'aria-label': label(c),
                  'data-flag': amber ? 'true' : undefined,
                  className: cn('text-base', amber && 'border-flag-strong bg-flag text-flag-foreground'),
                };
                return (
                  <div key={c} className={cn('flex min-w-0 flex-col gap-1.5', !half && 'col-span-2')}>
                    <label htmlFor={`item-${open}-${c}`} className="text-sm font-medium text-muted-foreground">
                      {label(c)}
                    </label>
                    {numeric ? (
                      <Input {...common} inputMode="decimal" className={cn(common.className, 'h-12 text-right tabular-nums')} onChange={(e) => onEdit(open, c, e.target.value)} />
                    ) : (
                      <Textarea {...common} rows={c === desc ? 3 : 1} className={cn(common.className, 'min-h-12')} onChange={(e) => onEdit(open, c, e.target.value)} />
                    )}
                    {messages.get(key) && !check && <p className="text-sm text-flag-foreground">{messages.get(key)}</p>}
                  </div>
                );
              })}
              </div>

              {(() => {
                if (!check) return null;
                return (
                  <p
                    data-testid="item-check"
                    className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-sm', check.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-flag text-flag-foreground')}
                  >
                    {check.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
                    <span>
                      {check.text}
                      {!check.ok && ' Please check; the app does not change your numbers.'}
                    </span>
                  </p>
                );
              })()}

              <div className="grid grid-cols-3 gap-2 pt-1">
                <Button variant="outline" disabled={open === 0} onClick={() => setOpen(open - 1)} aria-label="Previous item">
                  <ChevronLeft /> Prev
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive"
                  onClick={() => {
                    const at = open;
                    onDeleteRow(at);
                    setOpen(block.rows.length - 1 > 0 ? Math.min(at, block.rows.length - 2) : null);
                  }}
                  data-testid="delete-item"
                >
                  <Trash2 /> Delete
                </Button>
                {open < block.rows.length - 1 ? (
                  <Button variant="outline" onClick={() => setOpen(open + 1)} aria-label="Next item" data-testid="next-item">
                    Next <ChevronRight />
                  </Button>
                ) : (
                  <Button variant="outline" onClick={addItem} aria-label="Add item">
                    <Plus /> Add
                  </Button>
                )}
              </div>
              <Button onClick={() => setOpen(null)} data-testid="item-done">
                Done
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>

      {/* Column names (the table heading row). */}
      <Sheet open={columnsOpen} onOpenChange={setColumnsOpen}>
        <SheetContent title="Columns" description="The heading of each column." className="max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:rounded-none" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="flex flex-col gap-3 pb-2">
            {block.columns.map((header, c) => (
              <div key={c} className="flex items-end gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <label htmlFor={`col-${c}`} className="text-sm font-medium text-muted-foreground">
                    Column {c + 1}
                  </label>
                  <Input
                    id={`col-${c}`}
                    value={header}
                    data-flag={flagged.has(`-1:${c}`) ? 'true' : undefined}
                    className="h-12 text-base"
                    onChange={(e) => onEdit(-1, c, e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  aria-label={`Delete column ${c + 1}`}
                  disabled={n <= 1}
                  onClick={() => onDeleteCol(c)}
                  className="flex size-12 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 className="size-4.5" />
                </button>
              </div>
            ))}
            <Button variant="outline" onClick={() => onInsertCol(n)}>
              <Plus /> Add column
            </Button>
            <Button onClick={() => setColumnsOpen(false)}>Done</Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
