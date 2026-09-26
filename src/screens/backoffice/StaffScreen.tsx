/**
 * Staff (spec §5, §6.9; D-073, D-075, D-077, D-124, D-127): till users, their roles and PINs.
 * New PINs are typed twice. The service enforces PIN uniqueness ('That PIN can't be used —
 * choose another'), the last-manager rule and no self role change / self deactivation
 * (LAST_MANAGER). Saving needs 'manageMembersStaffSettings'. PIN hashes never reach the UI.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { CheckboxField, TextField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { Screen } from '../../components/Screen';
import { ROLE_LABELS } from '../../app/labels';
import { useLoad } from '../../app/useLoad';
import type { Role } from '../../data/types';
import { validateNewPin, validateStaffDetails } from '../../rules/validation';
import { createStaff, listStaff, updateStaff, type StaffSummary, type UpdateStaffInput } from '../../services/staff';
import { getCtx } from '../../store/appStore';
import { useSession, useSessionStore } from '../../store/sessionStore';
import { toast } from '../../store/uiStore';
import { digitsOnly, mergeErrors, useFocusFirstError, useGatedForm, type FieldErrors } from './formHelpers';
import { BackToMenu, Badge, ChoiceGroup, FormError, PermissionNote, type BadgeTone } from './parts';
import styles from './backoffice.module.css';
import staffStyles from './StaffScreen.module.css';

const ROLE_OPTIONS: { value: Role; label: string; hint: string }[] = [
  { value: 'staff', label: ROLE_LABELS.staff, hint: 'Sell, tabs, members and bookings' },
  { value: 'supervisor', label: ROLE_LABELS.supervisor, hint: 'Also voids, no sale and X read' },
  { value: 'manager', label: ROLE_LABELS.manager, hint: 'Everything, including the back office' },
];

const ROLE_TONES: Record<Role, BadgeTone> = { staff: 'neutral', supervisor: 'info', manager: 'brand' };

const FIELDS = ['name', 'role', 'active', 'pin', 'confirmPin'] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== '');
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export function StaffScreen() {
  const load = useLoad(listStaff, []);
  const session = useSession();
  const [editing, setEditing] = useState<StaffSummary | 'new' | null>(null);
  const staff = load.data;

  const saved = (summary: StaffSummary, message: string): void => {
    setEditing(null);
    load.reload();
    // The header shows the session's name: keep it in step when you rename yourself.
    const current = useSessionStore.getState().session;
    if (current !== null && current.staffId === summary.id && current.name !== summary.name) {
      useSessionStore.setState({ session: { ...current, name: summary.name } });
    }
    toast(message, { tone: 'success' });
  };

  return (
    <Screen
      title="Staff"
      description="Everyone who can log in to this till. Deactivated staff can't log in."
      actions={
        <>
          <BackToMenu />
          <Button variant="primary" onClick={() => setEditing('new')} disabled={staff === undefined} className={styles.titleAction}>
            Add staff
          </Button>
        </>
      }
    >
      <PermissionNote action="manageMembersStaffSettings" />
      {load.error !== null && <Banner tone="danger">{load.error}</Banner>}
      {staff === undefined && load.error === null && <p className={styles.muted}>Loading staff…</p>}
      {staff !== undefined && (
        <ul className={styles.gridList} aria-label="Staff">
          {staff.map((member) => (
            <li key={member.id}>
              <StaffRow member={member} isYou={session?.staffId === member.id} onEdit={() => setEditing(member)} />
            </li>
          ))}
        </ul>
      )}

      {editing === 'new' && <AddStaffDialog onClose={() => setEditing(null)} onSaved={(s) => saved(s, `${s.name} added`)} />}
      {editing !== null && editing !== 'new' && (
        <EditStaffDialog
          member={editing}
          isYou={session?.staffId === editing.id}
          onClose={() => setEditing(null)}
          onSaved={(s) => saved(s, s.active === editing.active ? `${s.name} saved` : s.active ? `${s.name} reactivated` : `${s.name} deactivated`)}
        />
      )}
    </Screen>
  );
}

function StaffRow({ member, isYou, onEdit }: { member: StaffSummary; isYou: boolean; onEdit: () => void }) {
  const metaId = useId();
  return (
    <button
      type="button"
      className={`${styles.rowButton} ${member.active ? '' : styles.rowInactive}`}
      onClick={onEdit}
      aria-label={`Edit ${member.name}`}
      aria-describedby={metaId}
      data-testid="staff-row"
    >
      <span className={`${staffStyles.avatar} ${staffStyles[`avatar_${member.role}`] ?? ''}`} aria-hidden="true">
        {initials(member.name)}
      </span>
      <span className={styles.rowMain}>
        <span className={styles.rowTitleLine}>
          <span className={styles.rowTitle}>{member.name}</span>
          {isYou && <Badge tone="success">You</Badge>}
        </span>
        <span id={metaId} className={styles.rowTitleLine}>
          <Badge tone={ROLE_TONES[member.role]}>{ROLE_LABELS[member.role]}</Badge>
          {!member.active && <Badge tone="danger">Inactive</Badge>}
          {isYou && <span className="visually-hidden">(you)</span>}
        </span>
      </span>
      <svg className={styles.chevron} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function PinFields({ pin, confirmPin, onPin, onConfirm, errors, labels }: {
  pin: string;
  confirmPin: string;
  onPin: (v: string) => void;
  onConfirm: (v: string) => void;
  errors: FieldErrors;
  labels: [string, string];
}) {
  return (
    <div className={styles.formGrid}>
      <TextField
        label={labels[0]}
        hint="4 to 6 digits"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        pattern="[0-9]*"
        value={pin}
        onChange={(v) => onPin(digitsOnly(v))}
        error={errors.pin}
      />
      <TextField
        label={labels[1]}
        hint="Type it again"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        pattern="[0-9]*"
        value={confirmPin}
        onChange={(v) => onConfirm(digitsOnly(v))}
        error={errors.confirmPin}
      />
    </div>
  );
}

/** The name check from validateStaffDetails, without the roster-dependent rules (the service checks those). */
function nameError(name: string, actingStaffId: string): FieldErrors {
  const result = validateStaffDetails({ name, role: 'manager', active: true }, { staff: [], actingStaffId });
  return !result.ok && result.errors.name !== undefined ? { name: result.errors.name } : {};
}

function AddStaffDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (s: StaffSummary) => void }) {
  const session = useSession();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const form = useGatedForm(FIELDS);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, form.fieldErrors);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const pinCheck = validateNewPin(pin, confirmPin);
    const problems = mergeErrors(nameError(name, session?.staffId ?? ''), pinCheck.ok ? {} : pinCheck.errors);
    if (Object.keys(problems).length > 0) {
      form.showErrors(problems);
      return;
    }
    const created = await form.run('manageMembersStaffSettings', (auth) => createStaff(getCtx(), auth, { name, role, pin, confirmPin }));
    if (created !== null) onSaved(created);
    else {
      // A rejected PIN is never kept on screen.
      setPin('');
      setConfirmPin('');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add staff"
      dismissible={!form.busy}
      testId="staff-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={form.busy}>
            Cancel
          </Button>
          <Button type="submit" form="staff-add-form" variant="primary" busy={form.busy}>
            Add staff
          </Button>
        </>
      }
    >
      <form id="staff-add-form" ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <FormError message={form.formError} />
        <TextField label="Name" value={name} onChange={setName} error={form.fieldErrors.name} maxLength={40} autoComplete="off" data-autofocus />
        <ChoiceGroup<Role> legend="Role" name="staff-role" value={role} onChange={setRole} options={ROLE_OPTIONS} error={form.fieldErrors.role} />
        <PinFields pin={pin} confirmPin={confirmPin} onPin={setPin} onConfirm={setConfirmPin} errors={form.fieldErrors} labels={['PIN', 'Confirm PIN']} />
        <p className={`${styles.muted} ${styles.small}`}>Each person needs their own PIN. It can't be the same as anyone else's.</p>
      </form>
    </Modal>
  );
}

function EditStaffDialog({ member, isYou, onClose, onSaved }: { member: StaffSummary; isYou: boolean; onClose: () => void; onSaved: (s: StaffSummary) => void }) {
  const session = useSession();
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState<Role>(member.role);
  const [active, setActive] = useState(member.active);
  const [resetPin, setResetPin] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const form = useGatedForm(FIELDS);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, form.fieldErrors);
  const reactivating = !member.active && active;
  const pinNeeded = resetPin || reactivating;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const pinCheck = pinNeeded ? validateNewPin(pin, confirmPin) : null;
    const problems = mergeErrors(nameError(name, session?.staffId ?? ''), pinCheck === null || pinCheck.ok ? {} : pinCheck.errors);
    if (Object.keys(problems).length > 0) {
      form.showErrors(problems);
      return;
    }
    const input: UpdateStaffInput = { name, role, active, ...(pinNeeded ? { newPin: { pin, confirmPin } } : {}) };
    const updated = await form.run('manageMembersStaffSettings', (auth) => updateStaff(getCtx(), auth, member.id, input));
    if (updated !== null) onSaved(updated);
    else {
      setPin('');
      setConfirmPin('');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit staff"
      description={member.name}
      dismissible={!form.busy}
      testId="staff-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={form.busy}>
            Cancel
          </Button>
          <Button type="submit" form="staff-edit-form" variant="primary" busy={form.busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="staff-edit-form" ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <FormError message={form.formError} />
        {isYou && (
          <Banner tone="info" role="none">
            This is you. You can change your name and PIN, but not your own role, and you can't deactivate yourself.
          </Banner>
        )}
        <TextField label="Name" value={name} onChange={setName} error={form.fieldErrors.name} maxLength={40} autoComplete="off" />
        <ChoiceGroup<Role> legend="Role" name="staff-role" value={role} onChange={setRole} options={ROLE_OPTIONS} error={form.fieldErrors.role} disabled={isYou} />
        <CheckboxField
          label="Active"
          hint={member.active ? 'Untick to stop this person logging in' : 'Tick to let this person log in again (needs a new PIN)'}
          checked={active}
          onChange={setActive}
          error={form.fieldErrors.active}
          disabled={isYou}
        />
        <section className={styles.formSection} aria-label="PIN">
          <h3 className={styles.formSectionTitle}>PIN</h3>
          {reactivating ? (
            <p className={`${styles.muted} ${styles.small}`}>Set a new PIN to reactivate {member.name}.</p>
          ) : (
            <CheckboxField label="Set a new PIN" checked={resetPin} onChange={setResetPin} />
          )}
          {pinNeeded && (
            <PinFields pin={pin} confirmPin={confirmPin} onPin={setPin} onConfirm={setConfirmPin} errors={form.fieldErrors} labels={['New PIN', 'Confirm new PIN']} />
          )}
        </section>
      </form>
    </Modal>
  );
}
