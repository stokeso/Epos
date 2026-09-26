/**
 * Members (spec §6.5; D-051, D-104, D-105; docs/ui-plan.md §7 "tabs-bookings-members").
 *
 * Everyone can search by name or member number (services/members.searchMembers: active members,
 * each shown as '1001 — Alice Archer'). With an empty search box the screen lists every active
 * member. Inactive members are listed separately so a manager can reactivate them.
 * Adding, editing and (de)activating are manager actions: the buttons are visible to everyone
 * (navigation is never gated, D-070) and Save asks for a Manager PIN when needed.
 */
import { useState } from 'react';
import { useLoad } from '../../app';
import { Banner, Button, Screen, SearchList, useDebouncedValue } from '../../components';
import type { Member } from '../../data/types';
import { can } from '../../rules/permissions';
import { listMembers, memberLabel, searchMembers } from '../../services/members';
import { toast, useSession } from '../../store';
import { MemberFormDialog } from './MemberFormDialog';
import styles from './MembersScreen.module.css';

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MemberSummary({ member }: { member: Member }) {
  return (
    <span className={styles.member}>
      <span className={styles.number}>{member.memberNumber}</span>
      <span className={styles.name}>
        {member.firstName} {member.lastName}
      </span>
      <Chevron />
    </span>
  );
}

export function MembersScreen() {
  const session = useSession();
  const all = useLoad(listMembers, []);
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 150);
  const search = useLoad((ctx) => searchMembers(ctx, debounced), [debounced]);
  const [editing, setEditing] = useState<Member | 'new' | null>(null);

  const members = all.data;
  const active = (members ?? []).filter((m) => m.active);
  const inactive = (members ?? []).filter((m) => !m.active);
  const searching = query.trim() !== '';
  const pending = searching && (search.loading || query.trim() !== debounced.trim());
  const results = searching ? (search.data ?? []) : active;
  const isManager = session !== null && can(session.role, 'manageMembersStaffSettings');

  const saved = (_member: Member, message: string): void => {
    setEditing(null);
    all.reload();
    search.reload();
    toast(message, { tone: 'success' });
  };

  let idleMessage: string | undefined;
  if (members === undefined) idleMessage = all.error === null ? 'Loading members…' : undefined;
  else if (active.length === 0) idleMessage = 'No active members yet.';
  else {
    idleMessage = `Showing all ${active.length} active ${active.length === 1 ? 'member' : 'members'}.`;
    if (inactive.length > 0) idleMessage += ` ${inactive.length} inactive ${inactive.length === 1 ? 'member is' : 'members are'} listed at the end.`;
  }

  return (
    <Screen
      title="Members"
      description="Search by name or member number."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')} disabled={members === undefined}>
          Add member
        </Button>
      }
    >
      <div className={styles.layout}>
        {!isManager && (
          <Banner tone="info" role="none">
            Adding or changing a member needs a manager PIN.
          </Banner>
        )}
        {all.error !== null && <Banner tone="danger">{all.error}</Banner>}

        <section className={styles.panel} aria-label="Find a member">
          <SearchList
            label="Search members"
            hint="Name or member number"
            placeholder="e.g. 1001 or Archer"
            query={query}
            onQueryChange={setQuery}
            results={pending ? [] : results}
            getKey={(m) => m.id}
            getItemLabel={memberLabel}
            renderItem={(m) => <MemberSummary member={m} />}
            onSelect={(m) => setEditing(m)}
            idleMessage={idleMessage}
            emptyMessage="No active members match"
            loading={pending}
            resultsLabel={searching ? 'Matching members' : 'Active members'}
          />
          {search.error !== null && <Banner tone="danger">{search.error}</Banner>}
        </section>

        {inactive.length > 0 && (
          <section className={styles.panel} aria-labelledby="inactive-members-heading">
            <div className={styles.sectionHead}>
              <h2 id="inactive-members-heading" className={styles.sectionTitle}>
                Inactive members <span className={styles.count}>({inactive.length})</span>
              </h2>
              <p className={styles.muted}>Not shown in searches at the till.</p>
            </div>
            <ul className={styles.list} aria-label="Inactive members">
              {inactive.map((m) => (
                <li key={m.id}>
                  <button type="button" className={styles.rowButton} onClick={() => setEditing(m)} aria-label={memberLabel(m)}>
                    <MemberSummary member={m} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {editing !== null && members !== undefined && (
        <MemberFormDialog
          key={editing === 'new' ? 'new' : editing.id}
          member={editing === 'new' ? null : editing}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </Screen>
  );
}
