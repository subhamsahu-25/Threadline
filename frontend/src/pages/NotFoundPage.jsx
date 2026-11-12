import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Compass } from 'lucide-react';
import { Button, Card } from '../components/ui.jsx';

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex min-h-[55vh] max-w-lg items-center">
      <Card className="w-full p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-slate-50 text-ink-muted">
          <Compass className="h-6 w-6" aria-hidden="true" />
        </div>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-faint">
          404 · not found
        </p>
        <h1 className="mt-2 text-[22px] font-semibold">This page is not part of a project</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-6 text-ink-muted">
          The link may be stale, or the section may have moved. Your projects and their handovers are
          still where you left them.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button icon={ArrowLeft} onClick={() => navigate('/')}>
            Back to projects
          </Button>
          <Link
            to="/"
            className="inline-flex h-9 items-center rounded-md px-3 text-[12.5px] font-semibold text-brand-700 transition hover:bg-brand-50"
          >
            Open workspace
          </Link>
        </div>
      </Card>
    </div>
  );
}
