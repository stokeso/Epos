/**
 * Members (spec §6.5; D-019, D-104, D-105).
 */
import { AppError } from '../data/errors';
import type { Member, NewMember } from '../data/types';
import { validateMember } from '../rules/validation';
import type { ServiceContext } from './context';
import { assertAuthorised, overrideEvents, type Authorisation } from './override';
import { compareIds, compareText, openPeriodId, validOrThrow } from './shared';

export const MEMBER_SEARCH_LIMIT = 20;

function byName(a: Member, b: Member): number {
  return (
    compareText(a.lastName, b.lastName) ||
    compareText(a.firstName, b.firstName) ||
    compareText(a.memberNumber, b.memberNumber) ||
    compareIds(a.id, b.id)
  );
}

/**
 * Member search (D-104): active, non-deleted members; case-insensitive "contains" on
 * memberNumber, firstName, lastName or 'firstName lastName'; trimmed query of >= 1 char (else []);
 * sorted by lastName, then firstName; at most MEMBER_SEARCH_LIMIT.
 */
export async function searchMembers(ctx: ServiceContext, query: string): Promise<Member[]> {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const members = await ctx.repos.members.list();
  return members
    .filter((m) => m.active && m.deletedAt === undefined)
    .filter((m) =>
      [m.memberNumber, m.firstName, m.lastName, `${m.firstName} ${m.lastName}`].some((field) => field.toLowerCase().includes(q)),
    )
    .sort(byName)
    .slice(0, MEMBER_SEARCH_LIMIT);
}

/** '1001 — Alice Archer' (D-104). */
export function memberLabel(member: Pick<Member, 'memberNumber' | 'firstName' | 'lastName'>): string {
  return `${member.memberNumber} — ${member.firstName} ${member.lastName}`;
}

/** All non-deleted members (active and inactive) sorted by lastName, firstName (back office). */
export async function listMembers(ctx: ServiceContext): Promise<Member[]> {
  return (await ctx.repos.members.list()).sort(byName);
}

async function requireMember(ctx: ServiceContext, id: string): Promise<Member> {
  const member = await ctx.repos.members.get(id);
  if (member === undefined || member.deletedAt !== undefined) throw new AppError('NOT_FOUND', 'That member no longer exists');
  return member;
}

/**
 * Create (id null) or update a member (D-105). auth.action 'manageMembersStaffSettings'.
 * validateMember (number uniqueness checked inside the transaction), then create/update +
 * overrideEvents.
 */
export async function saveMember(ctx: ServiceContext, auth: Authorisation, id: string | null, input: NewMember): Promise<Member> {
  assertAuthorised(auth, 'manageMembersStaffSettings');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    if (id !== null) await requireMember(ctx, id);
    const members = await ctx.repos.members.list();
    const value = validOrThrow(validateMember(input, { members, ...(id === null ? {} : { editingId: id }) }));
    const saved = id === null ? await ctx.repos.members.create(value) : await ctx.repos.members.update(id, value);
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return saved;
  });
}

/** Deactivate / reactivate (D-051). auth.action 'manageMembersStaffSettings'. */
export async function setMemberActive(ctx: ServiceContext, auth: Authorisation, id: string, active: boolean): Promise<Member> {
  assertAuthorised(auth, 'manageMembersStaffSettings');
  const periodId = await openPeriodId(ctx);
  return ctx.repos.transact(async () => {
    await requireMember(ctx, id);
    const saved = await ctx.repos.members.update(id, { active });
    await ctx.repos.auditEvents.append(overrideEvents(auth, periodId));
    return saved;
  });
}
