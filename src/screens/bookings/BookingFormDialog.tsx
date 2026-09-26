/**
 * Create a booking, or edit an open booking's details (spec §6.7; D-026): type, name, date and
 * optional notes. The fields are checked with rules/validation.validateBooking before the
 * permission gate (requirePermission('bookings'), which every role passes directly) and then
 * saved with services/bookings.saveBooking, which validates again.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, fieldErrorsOf, requirePermission } from '../../app';
import { Banner, Button, Modal, TextAreaField, TextField } from '../../components';
import type { Booking, BookingType } from '../../data/types';
import { validateBooking } from '../../rules/validation';
import { saveBooking } from '../../services/bookings';
import { getCtx } from '../../store';
import { TypeChoice } from './parts';
import styles from './bookings.module.css';

type FieldName = 'type' | 'name' | 'date' | 'notes';
type Errors = Partial<Record<FieldName, string>>;

const FIELDS: readonly FieldName[] = ['type', 'name', 'date', 'notes'];

function pickErrors(source: Readonly<Record<string, string>>): Errors {
  const errors: Errors = {};
  for (const key of FIELDS) {
    const message = source[key];
    if (message !== undefined) errors[key] = message;
  }
  return errors;
}

export interface BookingFormDialogProps {
  /** The open booking to edit, or null to create one. */
  booking: Booking | null;
  onClose: () => void;
  onSaved: (booking: Booking) => void;
}

export function BookingFormDialog({ booking, onClose, onSaved }: BookingFormDialogProps) {
  const editing = booking !== null;
  const formId = useId();
  const typeName = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [type, setType] = useState<BookingType>(booking?.type ?? 'wedding');
  const [name, setName] = useState(booking?.name ?? '');
  const [date, setDate] = useState(booking?.date ?? '');
  const [notes, setNotes] = useState(booking?.notes ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusErrors, setFocusErrors] = useState(0);

  useEffect(() => {
    if (focusErrors === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], fieldset[aria-describedby] input')?.focus();
  }, [focusErrors]);

  const showErrors = (next: Errors, message: string | null): void => {
    setErrors(next);
    setFormError(message);
    setFocusErrors((n) => n + 1);
  };

  const clearError = (field: FieldName): void => setErrors((e) => ({ ...e, [field]: undefined }));

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const input = { type, name, date, notes };
    const check = validateBooking(input);
    if (!check.ok) {
      showErrors(pickErrors(check.errors), null);
      return;
    }
    setErrors({});
    setFormError(null);
    const auth = await requirePermission('bookings');
    if (auth === null) return;
    setBusy(true);
    try {
      onSaved(await saveBooking(getCtx(), auth, editing ? booking.id : null, input));
    } catch (caught) {
      const fields = pickErrors(fieldErrorsOf(caught));
      showErrors(fields, Object.keys(fields).length > 0 ? null : errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit booking' : 'New booking'}
      description={editing ? booking.name : 'A wedding, society day or other event. Deposits are taken from the booking afterwards.'}
      size="md"
      dismissible={!busy}
      testId="booking-form-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            Save booking
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
        {formError !== null && <Banner tone="danger">{formError}</Banner>}
        <TypeChoice
          name={typeName}
          value={type}
          onChange={(value) => {
            setType(value);
            clearError('type');
          }}
          error={errors.type}
          disabled={busy}
        />
        <TextField
          label="Name"
          hint="Up to 60 characters, e.g. Smith & Jones Wedding"
          value={name}
          onChange={(v) => {
            setName(v);
            clearError('name');
          }}
          error={errors.name}
          autoComplete="off"
          maxLength={120}
          disabled={busy}
          data-autofocus
        />
        <TextField
          label="Date"
          type="date"
          value={date}
          onChange={(v) => {
            setDate(v);
            clearError('date');
          }}
          error={errors.date}
          className={styles.dateField}
          disabled={busy}
        />
        <TextAreaField
          label="Notes"
          hint="Optional, up to 500 characters"
          value={notes}
          onChange={(v) => {
            setNotes(v);
            clearError('notes');
          }}
          error={errors.notes}
          rows={3}
          maxLength={600}
          disabled={busy}
        />
      </form>
    </Modal>
  );
}
