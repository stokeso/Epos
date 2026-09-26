/**
 * Settings (spec §4 Settings, §6.2; D-057, D-058, D-078, D-105): club name, receipt footer,
 * auto-lock minutes, member discount % and the device's receipt prefix. deviceId and the receipt
 * counter are shown but never editable. Saving needs 'manageMembersStaffSettings', then the app
 * re-reads the settings (header name, auto-lock, discount) and reprices the open basket.
 */
import { useRef, useState, type FormEvent } from 'react';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { TextAreaField, TextField } from '../../components/FormField';
import { Screen } from '../../components/Screen';
import { useLoad } from '../../app/useLoad';
import type { Settings } from '../../data/types';
import { formatReceiptNumber } from '../../rules/sale';
import { formatDateTime } from '../../rules/time';
import { validateSettings, type SettingsInput } from '../../rules/validation';
import { getSettings, saveSettings } from '../../services/settings';
import { getCtx, useAppStore } from '../../store/appStore';
import { useBasketStore } from '../../store/basketStore';
import { toast } from '../../store/uiStore';
import { parseWholeNumber, useFocusFirstError, useGatedForm } from './formHelpers';
import { AffixField, BackToMenu, FormError, Panel, PermissionNote } from './parts';
import styles from './backoffice.module.css';
import settingsStyles from './SettingsScreen.module.css';

const FIELDS = ['clubName', 'receiptFooter', 'autoLockMinutes', 'memberDiscountPercent', 'devicePrefix'] as const;
const FOOTER_MAX = 200;

export function SettingsScreen() {
  const load = useLoad(getSettings, []);
  const settings = load.data;
  return (
    <Screen title="Settings" description="These apply to this till." actions={<BackToMenu />}>
      <PermissionNote action="manageMembersStaffSettings" />
      {load.error !== null && <Banner tone="danger">{load.error}</Banner>}
      {settings === undefined && load.error === null && <p className={styles.muted}>Loading settings…</p>}
      {settings !== undefined && <SettingsForm key={settings.updatedAt} settings={settings} onSaved={load.reload} />}
    </Screen>
  );
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [clubName, setClubName] = useState(settings.clubName);
  const [receiptFooter, setReceiptFooter] = useState(settings.receiptFooter);
  const [autoLockText, setAutoLockText] = useState(String(settings.autoLockMinutes));
  const [discountText, setDiscountText] = useState(String(settings.memberDiscountPercent));
  const [devicePrefix, setDevicePrefix] = useState(settings.devicePrefix);
  const form = useGatedForm(FIELDS);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, form.fieldErrors);
  const errors = form.fieldErrors;

  const input: SettingsInput = {
    clubName,
    receiptFooter,
    autoLockMinutes: parseWholeNumber(autoLockText),
    memberDiscountPercent: parseWholeNumber(discountText),
    devicePrefix,
  };
  // The preview only uses a prefix the validator accepts (D-058); the other fields are the saved ones.
  const prefixOk = validateSettings({ ...settings, devicePrefix }).ok;
  const nextReceipt = formatReceiptNumber(prefixOk ? devicePrefix.trim().toUpperCase() : settings.devicePrefix, settings.receiptCounter + 1);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const check = validateSettings(input);
    if (!check.ok) {
      form.showErrors(check.errors);
      return;
    }
    const saved = await form.run('manageMembersStaffSettings', (auth) => saveSettings(getCtx(), auth, input));
    if (saved === null) return;
    // The header name, auto-lock and member discount all read the cached settings.
    await useAppStore.getState().refreshSettings();
    void useBasketStore.getState().refresh();
    toast('Settings saved', { tone: 'success' });
    onSaved();
  };

  const footerLength = Array.from(receiptFooter.trim()).length;

  return (
    <div className={settingsStyles.layout}>
      <Panel title="Till settings">
        <form ref={formRef} className={styles.form} onSubmit={(event) => void submit(event)} noValidate aria-label="Till settings">
          <FormError message={form.formError} />
          <TextField label="Club name" hint="Shown in the header and on every receipt" value={clubName} onChange={setClubName} error={errors.clubName} maxLength={40} autoComplete="organization" />
          <TextAreaField
            label="Receipt footer"
            hint={`Printed at the bottom of receipts. ${footerLength} of ${FOOTER_MAX} characters.`}
            value={receiptFooter}
            onChange={setReceiptFooter}
            error={errors.receiptFooter}
            rows={3}
          />
          <div className={styles.formGrid}>
            <AffixField
              label="Auto-lock after"
              suffix="minutes"
              value={autoLockText}
              onChange={setAutoLockText}
              hint="1 to 60. The till locks when nobody has touched it for this long."
              maxLength={3}
              error={errors.autoLockMinutes}
            />
            <AffixField
              label="Member discount"
              suffix="%"
              value={discountText}
              onChange={setDiscountText}
              hint="0 to 100. Applies to member-discount products."
              maxLength={3}
              error={errors.memberDiscountPercent}
            />
          </div>
          <TextField
            label="Receipt prefix"
            hint={prefixOk ? `Up to 6 letters or digits. The next receipt will be ${nextReceipt}.` : 'Up to 6 letters or digits, e.g. BAR1.'}
            value={devicePrefix}
            onChange={(value) => setDevicePrefix(value.toUpperCase())}
            error={errors.devicePrefix}
            maxLength={6}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className={settingsStyles.prefix}
          />
          <div className={settingsStyles.actions}>
            <Button type="submit" variant="primary" size="lg" busy={form.busy}>
              Save settings
            </Button>
          </div>
        </form>
      </Panel>

      <div className={styles.stack}>
        <Panel title="Receipt preview" description="How the top and bottom of a receipt will look.">
          <div className={settingsStyles.receipt} aria-label="Receipt preview" role="img">
            <p className={settingsStyles.receiptClub}>{clubName.trim() === '' ? 'Club name' : clubName.trim()}</p>
            <p>Receipt {nextReceipt}</p>
            <span className={settingsStyles.receiptRule} aria-hidden="true" />
            <p className={settingsStyles.receiptFooter}>{receiptFooter.trim() === '' ? ' ' : receiptFooter.trim()}</p>
          </div>
        </Panel>
        <Panel title="This device">
          <dl className={styles.facts}>
            <dt>Receipts issued</dt>
            <dd className="tabular">{settings.receiptCounter}</dd>
            <dt>Next receipt</dt>
            <dd className="tabular" data-testid="next-receipt-number">
              {formatReceiptNumber(settings.devicePrefix, settings.receiptCounter + 1)}
            </dd>
            <dt>Last backup</dt>
            <dd>{settings.lastBackupAt === undefined ? 'Never' : formatDateTime(settings.lastBackupAt)}</dd>
            <dt>Device ID</dt>
            <dd className={settingsStyles.deviceId}>{settings.deviceId}</dd>
          </dl>
          <p className={`${styles.muted} ${styles.small}`}>Changing the prefix doesn't restart the receipt numbers.</p>
        </Panel>
      </div>
    </div>
  );
}
