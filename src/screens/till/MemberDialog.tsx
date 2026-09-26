/**
 * Attach a member to the basket (spec §6.5; D-104): search by name or member number, tap a
 * result to attach it (the discount applies at once), or detach the current member.
 */
import { useState } from 'react';
import { useLoad } from '../../app';
import { Banner, Button, Modal, SearchList, useDebouncedValue } from '../../components';
import type { Member } from '../../data/types';
import { memberLabel, searchMembers } from '../../services/members';
import { toast, useBasketStore } from '../../store';
import { tillErrorMessage } from './tillErrors';
import styles from './TillDialogs.module.css';

export const MEMBER_DIALOG_TITLE = 'Attach member';

export interface MemberDialogProps {
  open: boolean;
  onClose: () => void;
}

export function MemberDialog({ open, onClose }: MemberDialogProps) {
  if (!open) return null;
  return <MemberDialogBody onClose={onClose} />;
}

function MemberDialogBody({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 150);
  const results = useLoad((ctx) => searchMembers(ctx, debounced), [debounced]);
  const memberId = useBasketStore((s) => s.basket.memberId);
  const current = useBasketStore((s) => s.view?.member);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attach = async (member: Member): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const attached = await useBasketStore.getState().attachMember(member.id);
      if (attached) {
        toast(`Member attached: ${memberLabel(member)}`, { tone: 'success' });
        onClose();
      }
    } catch (caught) {
      setError(tillErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const detach = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await useBasketStore.getState().detachMember();
      toast('Member removed from the basket');
      onClose();
    } catch (caught) {
      setError(tillErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const searching = results.loading || query.trim() !== debounced.trim();
  const found = query.trim() === '' ? [] : (results.data ?? []);

  return (
    <Modal
      open
      onClose={onClose}
      title={MEMBER_DIALOG_TITLE}
      description={
        memberId === undefined ? (
          'The member discount applies to the basket as soon as a member is attached.'
        ) : (
          <>
            Attached now: <strong data-testid="member-dialog-current">{current === undefined ? 'Loading…' : memberLabel(current)}</strong>. Choose
            another member to replace them.
          </>
        )
      }
      size="md"
      dismissible={!busy}
      testId="member-dialog"
      footer={
        <>
          {memberId !== undefined && (
            <Button variant="dangerOutline" onClick={() => void detach()} disabled={busy}>
              Detach member
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <SearchList
          label="Search members"
          hint="Name or member number"
          placeholder="e.g. 1001 or Archer"
          query={query}
          onQueryChange={setQuery}
          results={found}
          getKey={(member) => member.id}
          getItemLabel={memberLabel}
          renderItem={(member) => (
            <span className={styles.memberResult}>
              <span className={styles.memberNumber}>{member.memberNumber}</span>
              <span className={styles.memberName}>
                {member.firstName} {member.lastName}
              </span>
              {member.id === memberId && <span className={styles.pill}>Attached</span>}
            </span>
          )}
          onSelect={(member) => void attach(member)}
          isSelected={(member) => member.id === memberId}
          idleMessage="Type a name or member number to search."
          emptyMessage="No active members match"
          loading={searching && query.trim() !== ''}
          resultsLabel="Matching members"
          autoFocus
          disabled={busy}
        />
        {results.error !== null && <Banner tone="danger">{results.error}</Banner>}
        {error !== null && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  );
}
