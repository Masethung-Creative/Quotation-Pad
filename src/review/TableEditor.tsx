import { memo, useCallback, useRef } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, MoreVertical, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/sheet';
import type { Align, LowConfidence, TableBlock } from '@/schema/canonical';
import { normaliseTable } from '@/schema/canonical';
import type { Issue } from '@/validate/totals';
import { cn } from '@/lib/utils';

interface Props {
  block: TableBlock;
  low?: LowConfidence;
  issues: Issue[];
  onChange: (block: TableBlock, low?: LowConfidence) => void;
}

const alignClass: Record<Align, string> = { left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-left' };

interface CellProps {
  row: number;
  col: number;
  value: string;
  align: Align;
  flagged: boolean;
  title?: string;
  header?: boolean;
  onEdit: (row: number, col: number, value: string) => void;
}

const Cell = memo(function Cell({ row, col, value, align, flagged, title, header, onEdit }: CellProps) {
  return (
    <Textarea
      value={value}
      title={title}
      aria-label={header ? `Column ${col + 1} heading` : `Row ${row + 1}, column ${col + 1}`}
      data-flag={flagged ? 'true' : undefined}
      onChange={(e) => onEdit(row, col, e.target.value)}
      className={cn(
        // w-0 + min-w-full: the textarea fills its cell but never widens the column by itself.
        'w-0 min-w-full rounded-none border-0 bg-transparent px-2 py-2 text-[15px] focus-visible:outline-offset-[-2px]',
        alignClass[align],
        header && 'font-semibold',
        flagged && 'bg-flag text-flag-foreground',
      )}
    />
  );
});

/** Shifts "row:col" keys after a row / column was inserted or removed. */
function remap(cells: string[] | undefined, fn: (r: number, c: number) => [number, number] | null): string[] {
  const out: string[] = [];
  for (const key of cells ?? []) {
    const [r, c] = key.split(':').map(Number);
    const next = fn(r, c);
    if (next) out.push(`${next[0]}:${next[1]}`);
  }
  return out;
}

export function TableEditor({ block: input, low, issues, onChange }: Props) {
  const block = normaliseTable(input);
  const latest = useRef({ block, low, onChange });
  latest.current = { block, low, onChange };

  const lowSet = new Set(low?.cells ?? []);
  const issueAt = new Map<string, string>();
  for (const issue of issues) {
    if (issue.kind === 'row' && issue.row !== undefined && issue.col !== undefined) issueAt.set(`${issue.row}:${issue.col}`, issue.message);
  }

  const emit = (next: TableBlock, cells: string[]) => {
    const { low: l, onChange: change } = latest.current;
    change(next, l || cells.length ? { ...l, cells } : l);
  };

  // Stable callback so only the edited cell re-renders while typing.
  const edit = useCallback((row: number, col: number, value: string) => {
    const { block: b, low: l, onChange: change } = latest.current;
    // Editing a cell means a human has looked at it: the amber flag goes away.
    const cells = (l?.cells ?? []).filter((k) => k !== `${row}:${col}`);
    const nextLow = l ? { ...l, cells } : l;
    if (row < 0) {
      change({ ...b, columns: b.columns.map((c, i) => (i === col ? value : c)) }, nextLow);
    } else {
      change({ ...b, rows: b.rows.map((r, ri) => (ri === row ? r.map((c, ci) => (ci === col ? value : c)) : r)) }, nextLow);
    }
  }, []);

  const n = block.columns.length;
  const insertRow = (at: number) => {
    const rows = [...block.rows.slice(0, at), Array<string>(n).fill(''), ...block.rows.slice(at)];
    emit({ ...block, rows }, remap(low?.cells, (r, c) => [r >= at ? r + 1 : r, c]));
  };
  const deleteRow = (at: number) => {
    emit({ ...block, rows: block.rows.filter((_, i) => i !== at) }, remap(low?.cells, (r, c) => (r === at ? null : [r > at ? r - 1 : r, c])));
  };
  const moveRow = (at: number, dir: -1 | 1) => {
    const to = at + dir;
    if (to < 0 || to >= block.rows.length) return;
    const rows = [...block.rows];
    [rows[at], rows[to]] = [rows[to], rows[at]];
    emit({ ...block, rows }, remap(low?.cells, (r, c) => [r === at ? to : r === to ? at : r, c]));
  };
  const insertCol = (at: number) => {
    const ins = <T,>(arr: T[], v: T) => [...arr.slice(0, at), v, ...arr.slice(at)];
    emit(
      { ...block, columns: ins(block.columns, ''), col_align: ins(block.col_align, 'left' as Align), rows: block.rows.map((r) => ins(r, '')), col_width: undefined },
      remap(low?.cells, (r, c) => [r, c >= at ? c + 1 : c]),
    );
  };
  const deleteCol = (at: number) => {
    if (n <= 1) return;
    const del = <T,>(arr: T[]) => arr.filter((_, i) => i !== at);
    emit(
      { ...block, columns: del(block.columns), col_align: del(block.col_align), rows: block.rows.map((r) => del(r)), col_width: undefined },
      remap(low?.cells, (r, c) => (c === at ? null : [r, c > at ? c - 1 : c])),
    );
  };
  const setAlign = (col: number, align: Align) => emit({ ...block, col_align: block.col_align.map((a, i) => (i === col ? align : a)) }, low?.cells ?? []);

  // Column width follows the longest content, within sensible limits for a phone.
  const widths = block.columns.map((header, c) => {
    let longest = header.length;
    for (const row of block.rows) for (const line of (row[c] ?? '').split('\n')) longest = Math.max(longest, line.length);
    return Math.min(26, Math.max(6, longest + 2));
  });

  return (
    <div>
      <div className="-mx-1 overflow-x-auto pb-1" data-testid="table-editor">
        <table className="w-max min-w-full border-collapse text-[15px]">
          <thead>
            <tr>
              <th className="w-11 border bg-muted" aria-hidden="true" />
              {block.columns.map((header, c) => (
                <th key={c} className="border bg-muted p-0 align-top font-normal" style={{ minWidth: `calc(${widths[c]}ch + 2.75rem)` }}>
                  <div className="flex items-start">
                    <div className="min-w-0 flex-1">
                      <Cell row={-1} col={c} value={header} align={block.col_align[c]} flagged={lowSet.has(`-1:${c}`)} header onEdit={edit} />
                    </div>
                    <Menu>
                      <MenuTrigger className="flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground hover:bg-card" aria-label={`Column ${c + 1} options`}>
                        <ChevronDown className="size-4" />
                      </MenuTrigger>
                      <MenuContent align="end">
                        <MenuLabel>Align column</MenuLabel>
                        <MenuItem onSelect={() => setAlign(c, 'left')}>
                          <AlignLeft /> Left
                        </MenuItem>
                        <MenuItem onSelect={() => setAlign(c, 'center')}>
                          <AlignCenter /> Centre
                        </MenuItem>
                        <MenuItem onSelect={() => setAlign(c, 'right')}>
                          <AlignRight /> Right (numbers)
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem onSelect={() => insertCol(c)}>
                          <ArrowLeft /> Add column before
                        </MenuItem>
                        <MenuItem onSelect={() => insertCol(c + 1)}>
                          <ArrowRight /> Add column after
                        </MenuItem>
                        <MenuItem destructive disabled={n <= 1} onSelect={() => deleteCol(c)}>
                          <Trash2 /> Delete column
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                <td className="border bg-muted p-0 align-top">
                  <Menu>
                    <MenuTrigger className="flex h-11 w-11 items-center justify-center text-muted-foreground hover:bg-card" aria-label={`Row ${r + 1} options`}>
                      <MoreVertical className="size-4" />
                    </MenuTrigger>
                    <MenuContent align="start">
                      <MenuItem onSelect={() => insertRow(r)}>
                        <ArrowUp /> Add row above
                      </MenuItem>
                      <MenuItem onSelect={() => insertRow(r + 1)}>
                        <ArrowDown /> Add row below
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem disabled={r === 0} onSelect={() => moveRow(r, -1)}>
                        <ArrowUp /> Move up
                      </MenuItem>
                      <MenuItem disabled={r === block.rows.length - 1} onSelect={() => moveRow(r, 1)}>
                        <ArrowDown /> Move down
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem destructive onSelect={() => deleteRow(r)}>
                        <Trash2 /> Delete row
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </td>
                {row.map((cell, c) => {
                  const key = `${r}:${c}`;
                  const message = issueAt.get(key);
                  return (
                    <td key={c} className="border bg-card p-0 align-top">
                      <Cell
                        row={r}
                        col={c}
                        value={cell}
                        align={block.col_align[c]}
                        flagged={lowSet.has(key) || message !== undefined}
                        title={message ?? (lowSet.has(key) ? 'The scan was unclear here. Please check.' : undefined)}
                        onEdit={edit}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button variant="ghost" size="sm" className="mt-1" onClick={() => insertRow(block.rows.length)}>
        <Plus /> Add row
      </Button>
    </div>
  );
}
