import { t } from '@moneyflow/shared';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { attachmentUrl } from '../lib/upload';

const u = t.agentsUi.media;

/**
 * Camada sobre a tela para ver um anexo grande (imagem ampliada, PDF,
 * markdown): fundo escuro, Esc fecha, o foco fica dentro enquanto aberta.
 */
export function MediaDialog({
  title,
  onClose,
  onKeyDown,
  actions,
  children,
  testId,
  wide,
}: {
  title: string;
  onClose: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  wide?: boolean;
}) {
  const card = useRef<HTMLDivElement>(null);
  const handler = useRef(onKeyDown);
  handler.current = onKeyDown;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    card.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      handler.current?.(event);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <>
      <div className="overlay media-overlay" onClick={onClose} />
      <div
        ref={card}
        className={wide ? 'media-dialog wide' : 'media-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
      >
        <div className="media-dialog-head">
          <span className="media-dialog-title" title={title}>
            {title}
          </span>
          {actions}
          <button type="button" className="icon-btn" onClick={onClose} aria-label={u.close} title={u.close}>
            <X />
          </button>
        </div>
        <div className="media-dialog-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

export type LightboxImage = { id: string; fileName: string };

/** Imagem ampliada, com navegação entre as imagens da conversa (setas do teclado também) e "baixar". */
export function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: LightboxImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const image = images[index];
  if (!image) return null;
  const many = images.length > 1;
  const go = (delta: number) => onIndex((index + delta + images.length) % images.length);
  return (
    <MediaDialog
      title={image.fileName}
      onClose={onClose}
      wide
      testId="image-lightbox"
      onKeyDown={(event) => {
        if (!many) return;
        if (event.key === 'ArrowLeft') go(-1);
        if (event.key === 'ArrowRight') go(1);
      }}
      actions={
        <>
          {many && <span className="mono text-xs text-muted">{u.imageOf(index + 1, images.length)}</span>}
          <a className="btn btn-ghost btn-sm" href={attachmentUrl(image.id)} data-testid="lightbox-download">
            <Download /> {u.download}
          </a>
        </>
      }
    >
      <div className="lightbox-stage">
        {many && (
          <button type="button" className="lightbox-nav prev" onClick={() => go(-1)} aria-label={u.previous} title={u.previous}>
            <ChevronLeft />
          </button>
        )}
        <img src={attachmentUrl(image.id, true)} alt={image.fileName} data-testid="lightbox-image" />
        {many && (
          <button type="button" className="lightbox-nav next" onClick={() => go(1)} aria-label={u.next} title={u.next}>
            <ChevronRight />
          </button>
        )}
      </div>
    </MediaDialog>
  );
}
