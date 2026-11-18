import { useLiveQuery } from 'dexie-react-hooks';
import { CheckCircle2, ChevronRight, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { db, type Conversion } from '@/db/db';
import { Link } from '@/lib/router';
import { formatWhen } from '@/lib/utils';

/** The last few quotations, to pick up where you left off. Loaded after the first screen is shown. */

function RecentItem({ item }: { item: Conversion }) {
  const target = item.status === 'rendered' && item.output_pdf ? `/done/${item.id}` : item.template_id ? `/review/${item.id}` : item.doc_type ? `/template/${item.id}` : `/type/${item.id}`;
  return (
    <li className="border-b last:border-b-0">
      <Link to={target} className="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-muted/60">
        <FileText className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{item.output_name ?? item.name}</span>
          <span className="block text-xs text-muted-foreground">{formatWhen(item.created_at)}</span>
        </span>
        {item.status === 'rendered' ? (
          <Badge variant="success">
            <CheckCircle2 /> Done
          </Badge>
        ) : (
          <Badge variant="flag">Not finished</Badge>
        )}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

export default function RecentList() {
  const recent = useLiveQuery(() => db.conversions.orderBy('created_at').reverse().limit(5).toArray(), []);
  if (!recent || recent.length === 0) return null;
  return (
    <section className="mt-8" aria-labelledby="recent-title">
      <h2 id="recent-title" className="mb-2 text-base font-semibold">
        Recent
      </h2>
      <ul className="overflow-hidden rounded-lg border bg-card">
        {recent.map((item) => (
          <RecentItem key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}
