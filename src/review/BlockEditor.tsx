import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Minus, Pencil, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { signatureLines } from '@/render/docdef';
import type { TemplateDef } from '@/templates/schema';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label, Segmented } from '@/components/ui/misc';
import { amountInWords } from '@/lib/format';
import type { Align, Block, LowConfidence } from '@/schema/canonical';
import { runsToText } from '@/schema/canonical';
import { findGrandTotal, type Issue } from '@/validate/totals';
import { cn } from '@/lib/utils';
import { pruneLowWords, type EditorBlock } from './model';
import { RichText } from './RichText';
import { TableEditor } from './TableEditor';

interface Props {
  eb: EditorBlock;
  issues: Issue[];
  def: TemplateDef;
  onChange: (block: Block, low?: LowConfidence) => void;
}

/** data-flag marks every amber field, so the "items need a check" banner can jump to them. */
const flag = (on: boolean) => (on ? 'true' : undefined);

const ALIGN3 = [
  { value: 'left' as Align, label: <AlignLeft />, title: 'Align left' },
  { value: 'center' as Align, label: <AlignCenter />, title: 'Align centre' },
  { value: 'right' as Align, label: <AlignRight />, title: 'Align right' },
];
const ALIGN4 = [...ALIGN3, { value: 'justify' as Align, label: <AlignJustify />, title: 'Justify' }];

/** True when the text still contains a word the scan was unsure about. */
function hasLow(low: LowConfidence | undefined, text: string): boolean {
  return !!low?.words?.some((w) => w && text.includes(w));
}

const flagClass = 'border-flag-strong bg-flag text-flag-foreground';

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive">
      <Trash2 className="size-4.5" />
    </button>
  );
}

export function BlockEditor({ eb, issues, def, onChange }: Props) {
  const { block, low } = eb;

  switch (block.type) {
    case 'heading':
      return (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Heading text"
            value={block.text}
            onChange={(e) => onChange({ ...block, text: e.target.value }, pruneLowWords(low, e.target.value))}
            data-flag={flag(hasLow(low, block.text))}
            className={cn(block.bold !== false && 'font-semibold', block.level === 1 ? 'text-lg' : 'text-base', hasLow(low, block.text) && flagClass)}
            style={{ textAlign: block.align === 'justify' ? 'left' : block.align }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              aria-label="Heading size"
              value={String(block.level) as '1' | '2' | '3'}
              onChange={(v) => onChange({ ...block, level: Number(v) as 1 | 2 | 3 }, low)}
              options={[
                { value: '1', label: 'Large' },
                { value: '2', label: 'Medium' },
                { value: '3', label: 'Small' },
              ]}
            />
            <Segmented aria-label="Alignment" value={block.align} onChange={(align) => onChange({ ...block, align }, low)} options={ALIGN3} />
            <button
              type="button"
              aria-label="Bold"
              aria-pressed={block.bold !== false}
              data-testid="heading-bold"
              onClick={() => onChange({ ...block, bold: block.bold === false }, low)}
              className={cn('flex size-11 shrink-0 items-center justify-center rounded-md border border-input', block.bold !== false ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}
            >
              <Bold className="size-4.5" />
            </button>
          </div>
        </div>
      );

    case 'meta':
      return (
        <div className="flex flex-col gap-2">
          {block.items.map((item, i) => {
            const set = (patch: Partial<typeof item>) => {
              const items = block.items.map((it, k) => (k === i ? { ...it, ...patch } : it));
              onChange({ ...block, items }, pruneLowWords(low, items.map((it) => `${it.label} ${it.value}`).join(' ')));
            };
            return (
              <div key={i} className="flex items-center gap-1.5">
                <Input aria-label={`Detail ${i + 1} name`} value={item.label} onChange={(e) => set({ label: e.target.value })} className="w-[38%] font-medium" placeholder="Ref No" />
                <Input aria-label={`Detail ${i + 1} value`} value={item.value} data-flag={flag(hasLow(low, item.value))} onChange={(e) => set({ value: e.target.value })} className={cn('flex-1', hasLow(low, item.value) && flagClass)} placeholder="Value" />
                <RemoveButton label={`Remove detail ${i + 1}`} onClick={() => onChange({ ...block, items: block.items.filter((_, k) => k !== i) }, low)} />
              </div>
            );
          })}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange({ ...block, items: [...block.items, { label: '', value: '' }] }, low)}>
            <Plus /> Add detail
          </Button>
        </div>
      );

    case 'paragraph':
      return (
        <div className="flex flex-col gap-2">
          <RichText
            ariaLabel="Paragraph text"
            runs={block.runs}
            low={low?.words}
            align={block.align}
            onChange={(runs) => onChange({ ...block, runs }, pruneLowWords(low, runsToText(runs)))}
          />
          <Segmented aria-label="Alignment" className="self-start" value={block.align} onChange={(align) => onChange({ ...block, align }, low)} options={ALIGN4} />
        </div>
      );

    case 'table':
      return <TableEditor block={block} low={low} issues={issues} onChange={onChange} />;

    case 'totals': {
      const grand = findGrandTotal(block);
      const wordsIssue = issues.find((i) => i.kind === 'amount_in_words');
      const allText = (items: typeof block.items, words: string | undefined) => `${items.map((it) => `${it.label} ${it.value}`).join(' ')} ${words ?? ''}`;
      return (
        <div className="flex flex-col gap-2">
          {block.items.map((item, i) => {
            const issue = issues.find((x) => x.item === i);
            const set = (patch: Partial<typeof item>) => {
              const items = block.items.map((it, k) => (k === i ? { ...it, ...patch } : it));
              onChange({ ...block, items }, pruneLowWords(low, allText(items, block.amount_in_words)));
            };
            return (
              <div key={i} className="flex items-center gap-1.5">
                <Input aria-label={`Total line ${i + 1} name`} value={item.label} onChange={(e) => set({ label: e.target.value })} className={cn('min-w-0 flex-1', item.bold && 'font-semibold')} placeholder="Sub Total" />
                <Input
                  aria-label={`Total line ${i + 1} amount`}
                  inputMode="decimal"
                  value={item.value}
                  title={issue?.message}
                  data-flag={issue || hasLow(low, item.value) ? 'true' : undefined}
                  onChange={(e) => set({ value: e.target.value })}
                  className={cn('w-[34%] text-right tabular-nums', item.bold && 'font-semibold', (issue || hasLow(low, item.value)) && flagClass)}
                  placeholder="0.00"
                />
                <button
                  type="button"
                  aria-label={`Bold line ${i + 1}`}
                  aria-pressed={!!item.bold}
                  onClick={() => set({ bold: !item.bold })}
                  className={cn('flex size-11 shrink-0 items-center justify-center rounded-md border border-input', item.bold ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground')}
                >
                  <Bold className="size-4.5" />
                </button>
                <RemoveButton label={`Remove total line ${i + 1}`} onClick={() => onChange({ ...block, items: block.items.filter((_, k) => k !== i) }, low)} />
              </div>
            );
          })}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange({ ...block, items: [...block.items, { label: '', value: '' }] }, low)}>
            <Plus /> Add line
          </Button>
          <div>
            <Label htmlFor={`words-${eb.id}`}>Amount in words</Label>
            <Textarea
              id={`words-${eb.id}`}
              className={cn('mt-1.5', (wordsIssue || hasLow(low, block.amount_in_words ?? '')) && flagClass)}
              data-flag={flag(!!wordsIssue || hasLow(low, block.amount_in_words ?? ''))}
              value={block.amount_in_words ?? ''}
              placeholder="Rupees ... Only"
              onChange={(e) => onChange({ ...block, amount_in_words: e.target.value || undefined }, pruneLowWords(low, allText(block.items, e.target.value)))}
            />
            {grand !== null ? (
              <Button variant="ghost" size="sm" className="mt-1" onClick={() => onChange({ ...block, amount_in_words: amountInWords(grand) }, low)}>
                <Wand2 /> Write it from the total
              </Button>
            ) : null}
          </div>
        </div>
      );
    }

    case 'list':
      return (
        <div className="flex flex-col gap-2">
          <Segmented
            aria-label="List style"
            className="self-start"
            value={block.ordered ? 'ol' : 'ul'}
            onChange={(v) => onChange({ ...block, ordered: v === 'ol' }, low)}
            options={[
              { value: 'ol', label: '1. 2. 3.' },
              { value: 'ul', label: '• • •' },
            ]}
          />
          {block.items.map((item, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className="flex h-11 w-6 shrink-0 items-center justify-end text-sm tabular-nums text-muted-foreground">{block.ordered ? `${i + 1}.` : '•'}</span>
              <Textarea
                aria-label={`List item ${i + 1}`}
                value={item}
                data-flag={flag(hasLow(low, item))}
                className={cn(hasLow(low, item) && flagClass)}
                onChange={(e) => {
                  const items = block.items.map((it, k) => (k === i ? e.target.value : it));
                  onChange({ ...block, items }, pruneLowWords(low, items.join(' ')));
                }}
              />
              <RemoveButton label={`Remove item ${i + 1}`} onClick={() => onChange({ ...block, items: block.items.filter((_, k) => k !== i) }, low)} />
            </div>
          ))}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange({ ...block, items: [...block.items, ''] }, low)}>
            <Plus /> Add item
          </Button>
        </div>
      );

    case 'signature': {
      const align = block.align ?? def.signature.align;
      if (block.auto) {
        const lines = signatureLines(block, def);
        return (
          <div className="flex flex-col gap-2" data-testid="signature-block">
            <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-[15px]" style={{ textAlign: align === 'center' ? 'center' : align === 'left' ? 'left' : 'right' }}>
              {lines.map((line, i) =>
                line.trim() ? (
                  <div key={i} className={cn(i === 0 && 'font-semibold')}>
                    {line}
                  </div>
                ) : (
                  <div key={i} className="py-2 text-xs italic text-muted-foreground">
                    (signature)
                  </div>
                ),
              )}
            </div>
            <p className="text-xs text-muted-foreground">From the {def.display_name} template.</p>
            <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange({ ...block, auto: false, lines }, low)}>
              <Pencil /> Write my own
            </Button>
          </div>
        );
      }
      const text = block.lines.join('\n');
      return (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Signature lines"
            value={text}
            data-flag={flag(hasLow(low, text))}
            className={cn(hasLow(low, text) && flagClass)}
            style={{ textAlign: align === 'center' ? 'center' : align === 'left' ? 'left' : 'right' }}
            onChange={(e) => onChange({ ...block, lines: e.target.value.split('\n') }, pruneLowWords(low, e.target.value))}
          />
          <p className="text-xs text-muted-foreground">An empty line leaves room for the signature.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented aria-label="Alignment" value={align} onChange={(next) => onChange({ ...block, align: next }, low)} options={ALIGN3} />
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...block, auto: true }, low)}>
              <RotateCcw /> Use the template's
            </Button>
          </div>
        </div>
      );
    }

    case 'spacer': {
      const set = (v: number) => onChange({ ...block, mm: Math.max(1, Math.min(80, v)) }, low);
      return (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Less space" onClick={() => set(block.mm - 1)}>
            <Minus />
          </Button>
          <span className="min-w-20 text-center text-sm tabular-nums">{block.mm} mm gap</span>
          <Button variant="outline" size="icon" aria-label="More space" onClick={() => set(block.mm + 1)}>
            <Plus />
          </Button>
        </div>
      );
    }
  }
}
