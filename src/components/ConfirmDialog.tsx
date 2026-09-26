import { useId, type ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: ReactNode;
  /** Default 'Confirm'. */
  confirmLabel?: string;
  /** Default 'Cancel'. */
  cancelLabel?: string;
  /** 'danger' makes the confirm button red. */
  tone?: 'default' | 'danger';
  /** Disables both buttons and shows a spinner on confirm. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Extra content under the message (e.g. an error Banner). */
  children?: ReactNode;
  testId?: string;
}

/** A yes/no dialog. For app-wide use without local state, call confirmDialog() from src/store. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
  children,
  testId,
}: ConfirmDialogProps) {
  const messageId = useId();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      // The message is the dialog's description: announced with the title, even though the danger
      // tone puts initial focus on the cancel button.
      describedBy={message === undefined ? undefined : messageId}
      size="sm"
      dismissible={!busy}
      testId={testId}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-autofocus={tone === 'danger' ? true : undefined}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message !== undefined && <div id={messageId}>{message}</div>}
      {children}
    </Modal>
  );
}
