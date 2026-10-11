import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <div className="page">
      <EmptyState
        icon={<Compass />}
        title="Página não encontrada"
        description="O endereço pode ter mudado. Use ⌘K para procurar."
        action={
          <Link to="/" className="btn btn-ghost">
            Voltar ao início
          </Link>
        }
      />
    </div>
  );
}
