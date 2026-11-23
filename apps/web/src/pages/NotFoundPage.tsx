import { t } from '@moneyflow/shared';
import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <div className="page">
      <EmptyState
        icon={<Compass />}
        title={t.shell.notFound}
        description={t.shell.notFoundHint}
        action={
          <Link to="/" className="btn btn-ghost">
            {t.shell.backHome}
          </Link>
        }
      />
    </div>
  );
}
