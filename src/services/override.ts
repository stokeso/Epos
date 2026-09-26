/**
 * Permission checks and PIN override (spec §5; D-070..D-072).
 *
 * The UI helper requirePermission(action) (src/app, UI workflow) calls authoriseDirect(); if that
 * returns null it opens the override dialog and calls approveOverride(). The resulting
 * Authorisation is passed to exactly ONE service call and then dropped (single use, D-071).
 * Every writing service asserts its expected action with assertAuthorised().
 */
import { AppError } from '../data/errors';
import type { Action, NewAuditEvent } from '../data/types';
import { ACTION_LABELS, can } from '../rules/permissions';
import { findStaffByPin, type Session } from './auth';
import type { ServiceContext } from './context';

/** Proof that one execution of `action` is allowed. */
export interface Authorisation {
  readonly action: Action;
  /** The logged-in user (requester), recorded as the actor on every record (D-072). */
  readonly staffId: string;
  /** Present only when approved by PIN override. */
  readonly approvedById?: string;
}

/** can(session.role, action) ? { action, staffId: session.staffId } : null. */
export function authoriseDirect(session: Session, action: Action): Authorisation | null {
  return can(session.role, action) ? { action, staffId: session.staffId } : null;
}

/**
 * Override (D-071): the PIN must match an active, non-deleted staff member whose role satisfies
 * can(role, action) now. Returns { action, staffId: session.staffId, approvedById } or null
 * ('PIN not accepted'). Writes nothing: the override audit event is written with the action.
 */
export async function approveOverride(
  ctx: ServiceContext,
  session: Session,
  action: Action,
  pin: string,
): Promise<Authorisation | null> {
  const approver = await findStaffByPin(ctx, pin);
  if (approver === undefined || !can(approver.role, action)) return null;
  return { action, staffId: session.staffId, approvedById: approver.id };
}

/** Throws AppError('PERMISSION_DENIED') unless auth.action === action. */
export function assertAuthorised(auth: Authorisation, action: Action): void {
  if (auth.action !== action) {
    throw new AppError('PERMISSION_DENIED', `Not authorised: ${ACTION_LABELS[action]}`);
  }
}

/**
 * [] without an override; otherwise [{ type: 'override', staffId, approvedById, periodId?,
 * detail: { action } }] to append in the same transaction as the action's own writes (D-072).
 */
export function overrideEvents(auth: Authorisation, periodId: string | undefined): NewAuditEvent[] {
  if (auth.approvedById === undefined) return [];
  return [
    {
      type: 'override',
      staffId: auth.staffId,
      approvedById: auth.approvedById,
      ...(periodId === undefined ? {} : { periodId }),
      detail: { action: auth.action },
    },
  ];
}

/** { staffId, approvedById? } for an action's own audit event (approvedById omitted when absent). */
export function auditActor(auth: Authorisation): { staffId: string; approvedById?: string } {
  return auth.approvedById === undefined ? { staffId: auth.staffId } : { staffId: auth.staffId, approvedById: auth.approvedById };
}
