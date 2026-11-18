import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline } from 'lucide-react';
import type { Align, Run } from '@/schema/canonical';
import { cn } from '@/lib/utils';

/**
 * Small rich-text field for paragraphs: plain typing plus bold / italic / underline.
 * Words that OCR was unsure about are shown in amber.
 * The DOM is the source of truth while the field has focus (uncontrolled), which keeps
 * the caret and the phone keyboard's composition stable.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function markLow(html: string, low: string[]): string {
  if (!low.length) return html;
  const words = [...new Set(low)]
    .filter((w) => w.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return html;
  const re = new RegExp(`(^|[\\s(\\[{"'])(${words.join('|')})(?=$|[\\s)\\]}"',.;:!?])`, 'g');
  return html.replace(re, (_m, pre: string, word: string) => `${pre}<mark class="flag">${word}</mark>`);
}

export function runsToHtml(runs: Run[], low: string[] = []): string {
  return runs
    .map((r) => {
      let html = markLow(esc(r.text), low);
      if (r.underline) html = `<u>${html}</u>`;
      if (r.italic) html = `<i>${html}</i>`;
      if (r.bold) html = `<b>${html}</b>`;
      return html;
    })
    .join('');
}

interface Style {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export function htmlToRuns(root: Node): Run[] {
  const runs: Run[] = [];
  const push = (text: string, s: Style) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && !!last.bold === s.bold && !!last.italic === s.italic && !!last.underline === s.underline) last.text += text;
    else runs.push({ text, bold: s.bold, italic: s.italic, underline: s.underline });
  };
  const walk = (node: Node, s: Style) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        push((child.textContent ?? '').replace(/\xA0/g, ' '), s);
        return;
      }
      if (child.nodeType !== 1) return;
      const el = child as HTMLElement;
      const tag = el.tagName;
      if (tag === 'BR') {
        push('\n', s);
        return;
      }
      // Browsers wrap new lines in <div> / <p>: treat each as a line break.
      if ((tag === 'DIV' || tag === 'P') && runs.length && !runs[runs.length - 1].text.endsWith('\n')) push('\n', s);
      const weight = el.style?.fontWeight;
      walk(el, {
        bold: s.bold || tag === 'B' || tag === 'STRONG' || weight === 'bold' || Number(weight) >= 600,
        italic: s.italic || tag === 'I' || tag === 'EM' || el.style?.fontStyle === 'italic',
        underline: s.underline || tag === 'U' || (el.style?.textDecoration ?? '').includes('underline'),
      });
    });
  };
  walk(root, { bold: false, italic: false, underline: false });
  // A trailing line break is the browser's placeholder, not content.
  while (runs.length && /\n$/.test(runs[runs.length - 1].text)) {
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\n+$/, '');
    if (!runs[runs.length - 1].text) runs.pop();
    else break;
  }
  return runs.length ? runs : [{ text: '' }];
}

interface Props {
  runs: Run[];
  low?: string[];
  align?: Align;
  onChange: (runs: Run[]) => void;
  ariaLabel: string;
  className?: string;
}

export function RichText({ runs, low = [], align = 'left', onChange, ariaLabel, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string>('');
  const lastKey = useRef<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState<Style>({ bold: false, italic: false, underline: false });

  // Write into the DOM only when the value changed from outside (not from our own typing).
  const serialised = JSON.stringify(runs);
  const key = `${serialised}|${low.join('\x01')}`;
  const sync = () => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = runsToHtml(runs, low);
    lastKey.current = key;
    lastEmitted.current = serialised;
  };
  useEffect(() => {
    if (key === lastKey.current) return;
    // While the user is typing, the DOM is ahead of React: leave it (and the caret) alone.
    if (serialised === lastEmitted.current && document.activeElement === ref.current) return;
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const next = htmlToRuns(el);
    lastEmitted.current = JSON.stringify(next);
    onChange(next);
  };

  const refreshActive = () => {
    try {
      setActive({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
      });
    } catch {
      // queryCommandState is unavailable: the buttons still work, they just do not light up.
    }
  };

  const command = (name: 'bold' | 'italic' | 'underline') => (event: React.PointerEvent) => {
    // Keep the selection inside the editor while the toolbar button is pressed.
    event.preventDefault();
    ref.current?.focus();
    document.execCommand(name);
    refreshActive();
    emit();
  };

  const tools: { name: 'bold' | 'italic' | 'underline'; icon: typeof Bold; label: string }[] = [
    { name: 'bold', icon: Bold, label: 'Bold' },
    { name: 'italic', icon: Italic, label: 'Italic' },
    { name: 'underline', icon: Underline, label: 'Underline' },
  ];

  return (
    <div className={className}>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onInput={emit}
        onFocus={() => {
          setFocused(true);
          refreshActive();
        }}
        onBlur={() => {
          setFocused(false);
          // Typing is over: redraw so the amber marks match the current text.
          if (key !== lastKey.current) sync();
        }}
        onKeyUp={refreshActive}
        onPointerUp={refreshActive}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.execCommand('insertLineBreak');
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        className="min-h-11 w-full whitespace-pre-wrap break-words rounded-md border border-input bg-card px-3 py-2.5 text-base leading-snug"
        style={{ textAlign: align === 'justify' ? 'left' : align }}
      />
      <div className={cn('mt-1.5 flex gap-1', !focused && 'hidden')} role="toolbar" aria-label="Text style">
        {tools.map((t) => (
          <button
            key={t.name}
            type="button"
            aria-label={t.label}
            aria-pressed={active[t.name]}
            onPointerDown={command(t.name)}
            className={cn('flex size-11 items-center justify-center rounded-md border border-input bg-card', active[t.name] && 'border-primary bg-primary text-primary-foreground')}
          >
            <t.icon className="size-4.5" />
          </button>
        ))}
      </div>
    </div>
  );
}
