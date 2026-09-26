/**
 * Settings (spec §4; D-057, D-058). Viewing needs no permission; saving needs
 * auth.action 'manageMembersStaffSettings'.
 */
import { AppError } from '../data/errors';
import type { Settings } from '../data/types';
import { validateSettings, type SettingsInput } from '../rules/validation';
import type { ServiceContext } from './context';
import { assertAuthorised, overrideEvents, type Authorisation } from './override';
import { openPeriodId, validOrThrow } from './shared';

/** The Settings row; throws AppError('NOT_INITIALISED') before first-run setup. */
export async function getSettings(ctx: ServiceContext): Promise<Settings> {
  const settings = await ctx.repos.settings.get();
  if (settings === undefined) throw new AppError('NOT_INITIALISED', 'The till has not been set up yet');
  return settings;
}

/**
 * validateSettings, then transact: settings.update(clubName, receiptFooter, autoLockMinutes,
 * memberDiscountPercent, devicePrefix) + overrideEvents. receiptCounter is never changed here.
 */
export async function saveSettings(ctx: ServiceContext, auth: Authorisation, input: SettingsInput): Promise<Settings> {
  assertAuthorised(auth, 'manageMembersStaffSettings');
  const value = validOrThrow(validateSettings(input));
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    const settings = await ctx.repos.settings.update({
      clubName: value.clubName,
      receiptFooter: value.receiptFooter,
      autoLockMinutes: value.autoLockMinutes,
      memberDiscountPercent: value.memberDiscountPercent,
      devicePrefix: value.devicePrefix,
    });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return settings;
  });
}
