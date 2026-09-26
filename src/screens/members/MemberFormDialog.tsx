/**
 * Add or edit a member (spec §6.5; D-051, D-105). Managers only: Save and Deactivate/Reactivate
 * go through requirePermission('manageMembersStaffSettings'), so anyone else gets the Manager PIN
 * dialog (D-070, D-071). The form checks the fields with rules/validation.validateMember before
 * asking for a PIN; the service checks them again (and number uniqueness) inside its transaction.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, fieldErrorsOf, requirePermission } from '../../app';
import { Banner, Button, Modal, TextField } from '../../components';
import type { Member } from '../../data/types';
import { validateMember } from '../../rules/validation';
import { memberLabel, saveMember, setMemberActive } from '../../services/members';
import { confirmDialog, getCtx } from '../../store';
import styles from './MembersScreen.module.css';

type FieldName = 'memberNumber' | 'firstName' | 'lastName' | 'active';
type Errors = Partial<Record<FieldName, string>>;

export interface MemberFormDialogProps {
  /** The member being edited, or null to add one. */
  member: Member | null;
  /** Every non-deleted member (for the number check and the suggested next number). */
  members: readonly Member[];
  onClose: () => void;
  /** After a successful save / status change, with a toast message. */
  onSaved: (member: Member, message: string) => void;
}

/** The next free all-digit member number (e.g. '1021' after 1001..1020), or '' when none are numeric. */
function suggestNumber(members: readonly Member[]): string {
  let highest = 0;
  for (const m of members) {
    if (/^\d{1,9}$/.test(m.memberNumber)) highest = Math.max(highest, Number(m.memberNumber));
  }
  return highest === 0 ? '' : String(highest + 1);
}

function pickErrors(source: Readonly<Record<string, string>>): Errors {
  const errors: Errors = {};
  for (const key of ['memberNumber', 'firstName', 'lastName', 'active'] as const) {
    const message = source[key];
    if (message !== undefined) errors[key] = message;
  }
  return errors;
}

export function MemberFormDialog({ member, members, onClose, onSaved }: MemberFormDialogProps) {
  const editing = member !== null;
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [memberNumber, setMemberNumber] = useState(member?.memberNumber ?? suggestNumber(members));
  const [firstName, setFirstName] = useState(member?.firstName ?? '');
  const [lastName, setLastName] = useState(member?.lastName ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'status' | null>(null);
  const [focusErrors, setFocusErrors] = useState(0);

  // Move focus to the first invalid field after a rejected save.
  useEffect(() => {
    if (focusErrors === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusErrors]);

  const showErrors = (next: Errors, message: string | null): void => {
    setErrors(next);
    setFormError(message);
    setFocusErrors((n) => n + 1);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy !== null) return;
    const input = { memberNumber, firstName, lastName, active: member?.active ?? true };
    const check = validateMember(input, { members, ...(editing ? { editingId: member.id } : {}) });
    if (!check.ok) {
      showErrors(pickErrors(check.errors), null);
      return;
    }
    setErrors({});
    setFormError(null);
    const auth = await requirePermission('manageMembersStaffSettings');
    if (auth === null) return;
    setBusy('save');
    try {
      const saved = await saveMember(getCtx(), auth, editing ? member.id : null, input);
      onSaved(saved, editing ? `${memberLabel(saved)} saved` : `${memberLabel(saved)} added`);
    } catch (caught) {
      const fields = pickErrors(fieldErrorsOf(caught));
      showErrors(fields, Object.keys(fields).length > 0 ? null : errorMessage(caught));
      setBusy(null);
    }
  };

  const changeStatus = async (): Promise<void> => {
    if (member === null || busy !== null) return;
    const deactivating = member.active;
    if (deactivating) {
      const confirmed = await confirmDialog({
        title: 'Deactivate this member?',
        message: `${memberLabel(member)} will no longer appear in member searches at the till. You can reactivate them later.`,
        confirmLabel: 'Deactivate',
        cancelLabel: 'Keep active',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    const auth = await requirePermission('manageMembersStaffSettings');
    if (auth === null) return;
    setBusy('status');
    setFormError(null);
    try {
      const saved = await setMemberActive(getCtx(), auth, member.id, !deactivating);
      onSaved(saved, `${memberLabel(saved)} ${deactivating ? 'deactivated' : 'reactivated'}`);
    } catch (caught) {
      setFormError(errorMessage(caught));
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit member' : 'Add member'}
      description={editing ? memberLabel(member) : 'Members get the member discount when they are attached to a bill.'}
      size="md"
      dismissible={busy === null}
      testId="member-form-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy === 'save'} disabled={busy !== null}>
            Save member
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
        {formError !== null && <Banner tone="danger">{formError}</Banner>}
        <TextField
          label="Member number"
          hint="Up to 12 letters, digits or hyphens"
          value={memberNumber}
          onChange={(v) => {
            setMemberNumber(v);
            setErrors((e) => ({ ...e, memberNumber: undefined }));
          }}
          error={errors.memberNumber}
          className={styles.numberField}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
          disabled={busy !== null}
          data-autofocus={editing ? undefined : true}
        />
        <div className={styles.nameRow}>
          <TextField
            label="First name"
            value={firstName}
            onChange={(v) => {
              setFirstName(v);
              setErrors((e) => ({ ...e, firstName: undefined }));
            }}
            error={errors.firstName}
            autoComplete="off"
            autoCapitalize="words"
            maxLength={60}
            disabled={busy !== null}
            data-autofocus={editing ? true : undefined}
          />
          <TextField
            label="Last name"
            value={lastName}
            onChange={(v) => {
              setLastName(v);
              setErrors((e) => ({ ...e, lastName: undefined }));
            }}
            error={errors.lastName}
            autoComplete="off"
            autoCapitalize="words"
            maxLength={60}
            disabled={busy !== null}
          />
        </div>
        {editing && (
          <div className={styles.statusLine} data-testid="member-status">
            {member.active ? (
              <span className={styles.name}>Active: shown in member searches at the till.</span>
            ) : (
              <span className={styles.name}>
                <span className={`${styles.pill} ${styles.pillInactive}`}>Inactive</span> Hidden from member searches at the till.
              </span>
            )}
            <Button
              variant={member.active ? 'dangerOutline' : 'secondary'}
              size="sm"
              onClick={() => void changeStatus()}
              busy={busy === 'status'}
              disabled={busy !== null}
            >
              {member.active ? 'Deactivate member' : 'Reactivate member'}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
