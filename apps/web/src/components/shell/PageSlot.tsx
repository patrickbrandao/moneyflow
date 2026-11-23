import { t } from '@moneyflow/shared';
import { AlertCircle, RotateCw } from 'lucide-react';
import { Component, type ReactNode, Suspense } from 'react';
import { Button, EmptyState } from '../ui';

/**
 * O lugar da tela dentro da casca (tarefa 128): o carregando enquanto o pedaço
 * da tela chega (só na primeira visita; a troca de rota é uma transição, que
 * mantém a tela anterior até a nova estar pronta) e o aviso quando a tela não
 * carrega ou falha ao abrir, sem derrubar a casca. Trocar de endereço
 * (`resetKey`) limpa o aviso.
 */
export function PageSlot({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  return (
    <ErrorBoundary resetKey={resetKey} fallback={<PageError />}>
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-label={t.common.loading} data-testid="page-loading">
      <div className="spinner" />
    </div>
  );
}

function PageError() {
  return (
    <div className="page" data-testid="page-error">
      <EmptyState
        icon={<AlertCircle />}
        title={t.shell.pageError}
        description={t.shell.pageErrorHint}
        action={
          <Button variant="ghost" onClick={() => window.location.reload()}>
            <RotateCw /> {t.shell.reload}
          </Button>
        }
      />
    </div>
  );
}

type BoundaryProps = { resetKey: string; fallback: ReactNode; children: ReactNode };
type BoundaryState = { failed: boolean; resetKey: string };

/**
 * Segura o erro de um pedaço sob demanda (ou da tela que ele traz) e mostra o
 * `fallback` no lugar, em vez de desmontar o console inteiro. Um `resetKey`
 * novo (outro endereço, outra sessão) tenta de novo.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
