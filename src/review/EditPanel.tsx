import { forwardRef } from 'react';
import { ArrowDown, ArrowUp, FileText, Heading, List, MoreVertical, Plus, SeparatorHorizontal, Sigma, Signature, Table, Text, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/sheet';
import { BLOCK_LABEL, blockText, type Block, type BlockType, type LowConfidence } from '@/schema/canonical';
import type { TemplateDef } from '@/templates/schema';
import type { Issue } from '@/validate/totals';
import { cn } from '@/lib/utils';
import { BlockEditor } from './BlockEditor';
import { lowCount, type EditorBlock } from './model';

export const BLOCK_ICON: Record<BlockType, typeof Text> = {
  heading: Heading,
  meta: FileText,
  paragraph: Text,
  table: Table,
  totals: Sigma,
  list: List,
  signature: Signature,
  spacer: SeparatorHorizontal,
};

/** Simple conversions between the text-like block types. */
function convertBlock(block: Block, to: BlockType): Block | null {
  const text = blockText(block);
  const lines = text.split('\n').map((l) => l.trim());
  switch (to) {
    case 'paragraph':
      return { type: 'paragraph', runs: [{ text }], align: 'align' in block && block.align ? block.align : 'left' };
    case 'heading':
      return { type: 'heading', text: lines.filter(Boolean).join(' '), level: 1, align: 'center' };
    case 'list':
      return { type: 'list', ordered: true, items: lines.filter(Boolean).map((l) => l.replace(/^\(?\d{1,2}[.)]\s+/, '')) };
    case 'signature':
      return { type: 'signature', lines, align: 'right' };
    default:
      return null;
  }
}

const CONVERTIBLE: Partial<Record<BlockType, BlockType[]>> = {
  paragraph: ['heading', 'list'],
  heading: ['paragraph'],
  list: ['paragraph'],
  meta: ['paragraph'],
};

interface Props {
  blocks: EditorBlock[];
  issuesByBlock: Map<number, Issue[]>;
  def: TemplateDef;
  onChange: (id: string, block: Block, low?: LowConfidence) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemove: (index: number) => void;
  onAdd: (at: number) => void;
}

/** The quotation as a list of parts. Every field is editable in place; amber = please check. */
export const EditPanel = forwardRef<HTMLDivElement, Props>(function EditPanel({ blocks, issuesByBlock, def, onChange, onMove, onRemove, onAdd }, ref) {
  return (
    <div ref={ref}>
      {blocks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-input bg-card/60 px-5 py-8 text-center">
          <p className="font-semibold">No text was found in this file</p>
          <p className="mt-1 text-sm text-muted-foreground">Add the parts yourself, or go back and try a clearer scan.</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-3" data-testid="blocks">
        {blocks.map((eb, index) => {
          const Icon = BLOCK_ICON[eb.block.type];
          const issues = issuesByBlock.get(index) ?? [];
          const flagged = issues.length > 0 || lowCount(eb) > 0;
          const conversions = CONVERTIBLE[eb.block.type] ?? [];
          return (
            <Card key={eb.id} id={`block-${eb.id}`} className={cn('scroll-mt-28 p-3', flagged && 'border-amber-400')} data-testid="block" data-type={eb.block.type}>
              <div className="-mr-1.5 -mt-1.5 mb-1 flex items-center gap-1">
                <Badge variant={flagged ? 'flag' : 'muted'}>
                  <Icon /> {BLOCK_LABEL[eb.block.type]}
                </Badge>
                {flagged ? <span className="text-xs font-medium text-flag-strong">Please check</span> : null}
                <span className="flex-1" />
                <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => onMove(index, -1)} className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30">
                  <ArrowUp className="size-4.5" />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={index === blocks.length - 1}
                  onClick={() => onMove(index, 1)}
                  className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <ArrowDown className="size-4.5" />
                </button>
                <Menu>
                  <MenuTrigger className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label={`${BLOCK_LABEL[eb.block.type]} options`}>
                    <MoreVertical className="size-4.5" />
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem onSelect={() => onAdd(index)}>
                      <ArrowUp /> Add a part above
                    </MenuItem>
                    <MenuItem onSelect={() => onAdd(index + 1)}>
                      <ArrowDown /> Add a part below
                    </MenuItem>
                    {conversions.length ? <MenuSeparator /> : null}
                    {conversions.length ? <MenuLabel>Change to</MenuLabel> : null}
                    {conversions.map((to) => {
                      const ToIcon = BLOCK_ICON[to];
                      return (
                        <MenuItem
                          key={to}
                          onSelect={() => {
                            const next = convertBlock(eb.block, to);
                            if (next) onChange(eb.id, next, eb.low);
                          }}
                        >
                          <ToIcon /> {BLOCK_LABEL[to]}
                        </MenuItem>
                      );
                    })}
                    <MenuSeparator />
                    <MenuItem destructive onSelect={() => onRemove(index)}>
                      <Trash2 /> Remove this part
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </div>
              <BlockEditor eb={eb} issues={issues} def={def} onChange={(block, low) => onChange(eb.id, block, low)} />
              {issues.map((issue, k) => (
                <p key={k} className="mt-2 flex gap-2 rounded-md bg-flag/70 px-2.5 py-2 text-sm text-flag-foreground" data-testid="issue">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {issue.message}
                </p>
              ))}
            </Card>
          );
        })}
      </div>

      <Button variant="outline" className="mt-4 w-full border-dashed" onClick={() => onAdd(blocks.length)}>
        <Plus /> Add a part
      </Button>
    </div>
  );
});
