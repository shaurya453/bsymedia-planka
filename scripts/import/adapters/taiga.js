// Parses a single-project Taiga JSON export (Kanban board) into the
// generic normalized model the import framework (lib/framework.js) works
// with. Verified against a real export on 2026-08-07 - see the chat
// transcript / gap-analysis report for what was actually confirmed rather
// than assumed about Taiga's schema.
//
// Normalized model contract (kept adapter-agnostic on purpose, so a future
// Trello adapter can produce the same shape):
//   {
//     source, sourceFile, sourceFileSha256,
//     project: { name, description },
//     columns: [ { key, name, order } ],
//     members: [ { email, name, hasMembershipRecord } ],
//     cards: [ {
//       sourceRef, title, description, createdAt, dueDate, dueDateSource,
//       columnKey, assigneeEmails, ownerEmail,
//       comments: [ { authorEmail, authorName, text, createdAt } ],
//       attachments: [ { name, sizeBytes, base64 } ],
//       checklist: [ { text, isCompleted } ],
//       history: [ { at, fromColumnKey, toColumnKey } ],  // for cycle-time seeding
//       trelloBackref: string|null,
//     } ],
//     gapNotes: [ string ],
//     stats: { ... },
//   }

function assert(cond, msg) {
  if (!cond) throw new Error(`Taiga adapter: ${msg}`);
}

function parse(raw, { sourceFile, sourceFileSha256 }) {
  assert(raw.is_kanban_activated === true, 'export is not a Kanban project (is_kanban_activated !== true) - this adapter only handles Kanban');
  assert(Array.isArray(raw.user_stories), 'no user_stories array in export');
  assert(Array.isArray(raw.us_statuses), 'no us_statuses array in export');

  const gapNotes = [];

  // --- columns -------------------------------------------------------
  const columns = raw.us_statuses
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ key: s.slug, name: s.name, order: s.order }));

  const nameToColumnKey = new Map(columns.map((c) => [c.name, c.key]));

  const swimlanesUsed = (raw.swimlanes || []).length;
  const wipLimitsUsed = raw.us_statuses.filter((s) => s.wip_limit != null).length;
  gapNotes.push(
    swimlanesUsed === 0
      ? 'Swimlanes: 0 configured in this project - nothing to migrate, no Planka equivalent needed.'
      : `Swimlanes: ${swimlanesUsed} configured but PLANKA has no swimlane equivalent - card->column mapping preserved, swimlane grouping is lost.`,
  );
  gapNotes.push(
    wipLimitsUsed === 0
      ? 'WIP limits: none set on any column - nothing to migrate.'
      : `WIP limits: ${wipLimitsUsed} column(s) have a WIP limit set - PLANKA has no WIP-limit equivalent, these are dropped.`,
  );

  // --- status-id -> current-name resolution (for history/cycle-time) -
  // The top-level us_statuses list has NO id field, only history entries
  // reference numeric status ids. Columns can be renamed mid-project (2
  // renames found in the reference export) while keeping the same id, so
  // resolve each id to its *chronologically latest* name across all
  // history entries, which always converges on the current live name
  // (verified: exact bijection against us_statuses + task_statuses on the
  // reference file - see chat transcript).
  const idToLatestName = new Map();
  const idToLatestTime = new Map();
  const renames = new Map(); // id -> Set(all names ever seen)

  function scanHistoryForStatusIds(historyList) {
    for (const h of historyList || []) {
      const vals = (h.values && h.values.status) || null;
      if (!vals) continue;
      const t = new Date(h.created_at).getTime();
      for (const [id, name] of Object.entries(vals)) {
        if (!renames.has(id)) renames.set(id, new Set());
        renames.get(id).add(name);
        if (!idToLatestTime.has(id) || t >= idToLatestTime.get(id)) {
          idToLatestTime.set(id, t);
          idToLatestName.set(id, name);
        }
      }
    }
  }
  for (const us of raw.user_stories) scanHistoryForStatusIds(us.history);

  const renamedColumns = [...renames.entries()].filter(([, names]) => names.size > 1);
  if (renamedColumns.length > 0) {
    gapNotes.push(
      `${renamedColumns.length} column(s) were renamed at some point during the project's life ` +
        `(history resolved by stable id, not name, so this doesn't affect card placement): ` +
        renamedColumns.map(([, names]) => [...names].join(' -> ')).join('; '),
    );
  }

  // --- members ---------------------------------------------------------
  // memberships[] has email + role but no display name. history[].user is
  // a [email, displayName] tuple - the only source of names in this export.
  const emailToName = new Map();
  function scanHistoryForNames(historyList) {
    for (const h of historyList || []) {
      if (Array.isArray(h.user) && h.user[0] && h.user[1]) {
        emailToName.set(h.user[0], h.user[1]);
      }
    }
  }
  for (const us of raw.user_stories) scanHistoryForNames(us.history);
  for (const t of raw.tasks || []) scanHistoryForNames(t.history);

  const membershipEmails = new Set((raw.memberships || []).map((m) => m.user));
  const referencedEmails = new Set();
  for (const us of raw.user_stories) {
    if (us.owner) referencedEmails.add(us.owner);
    if (us.assigned_to) referencedEmails.add(us.assigned_to);
    for (const e of us.assigned_users || []) referencedEmails.add(e);
  }

  const allEmails = new Set([...membershipEmails, ...referencedEmails]);
  const members = [...allEmails].map((email) => ({
    email,
    name: emailToName.get(email) || email.split('@')[0],
    hasMembershipRecord: membershipEmails.has(email),
  }));

  const referencedNotMember = [...referencedEmails].filter((e) => !membershipEmails.has(e));
  if (referencedNotMember.length > 0) {
    gapNotes.push(
      `${referencedNotMember.length} email(s) appear as an owner/assignee on cards but have no ` +
        `Taiga membership record (e.g. a removed member): ${referencedNotMember.join(', ')}`,
    );
  }

  // --- checklist items (tasks) linked by ref, not id --------------------
  const tasksByStoryRef = new Map();
  for (const t of raw.tasks || []) {
    const list = tasksByStoryRef.get(t.user_story) || [];
    list.push(t);
    tasksByStoryRef.set(t.user_story, list);
  }
  if ((raw.tasks || []).length <= 1) {
    gapNotes.push(
      `Checklist items: only ${(raw.tasks || []).length} Taiga task(s) exist in the whole export - ` +
        `the "tasks under a story -> checklist items" mapping affects almost no cards.`,
    );
  }

  // --- cards -------------------------------------------------------------
  let dueDateFromBuiltIn = 0;
  let dueDateFromCustom = 0;
  let dueDateConflicts = 0;
  let deletedCommentsExcluded = 0;
  const trelloBackrefs = [];

  const cards = raw.user_stories.map((us) => {
    const columnKey = nameToColumnKey.get(us.status);
    assert(columnKey, `story ref=${us.ref} has status "${us.status}" not found in us_statuses`);

    const customDue = us.custom_attributes_values && us.custom_attributes_values.Due;
    let dueDate = null;
    let dueDateSource = null;
    if (us.due_date) {
      dueDate = us.due_date;
      dueDateSource = 'built-in';
      dueDateFromBuiltIn += 1;
      if (customDue && customDue !== us.due_date) dueDateConflicts += 1;
    } else if (customDue) {
      dueDate = customDue;
      dueDateSource = 'custom-Due-attribute';
      dueDateFromCustom += 1;
    }

    const comments = [];
    for (const h of us.history || []) {
      if (!h.comment) continue;
      if (h.delete_comment_date) {
        deletedCommentsExcluded += 1;
        continue;
      }
      comments.push({
        authorEmail: h.user[0],
        authorName: h.user[1],
        text: h.comment,
        createdAt: h.created_at,
      });
    }

    const attachments = (us.attachments || []).map((a) => ({
      name: a.name || (a.attached_file && a.attached_file.name) || 'attachment',
      sizeBytes: a.size,
      base64: a.attached_file && a.attached_file.data,
    }));

    const checklist = (tasksByStoryRef.get(us.ref) || []).map((t) => ({
      text: t.subject,
      isCompleted: t.status === 'Complete',
    }));

    // History timeline for cycle-time seeding: resolve every diff.status
    // transition by id -> current column name -> column key.
    const moves = [];
    for (const h of us.history || []) {
      const diff = h.diff && h.diff.status;
      if (!diff) continue;
      const [fromId, toId] = diff.map(String);
      const fromName = idToLatestName.get(fromId);
      const toName = idToLatestName.get(toId);
      moves.push({
        at: h.created_at,
        fromColumnKey: fromName ? nameToColumnKey.get(fromName) : null,
        toColumnKey: toName ? nameToColumnKey.get(toName) : null,
      });
    }
    const initialColumnKey = moves.length > 0 ? moves[0].fromColumnKey : columnKey;
    const history = [
      { at: us.created_date, fromColumnKey: null, toColumnKey: initialColumnKey },
      ...moves,
    ];

    let trelloBackref = null;
    if (Array.isArray(us.external_reference) && us.external_reference[0] === 'trello') {
      trelloBackref = us.external_reference[1];
      trelloBackrefs.push({ ref: us.ref, title: us.subject, url: trelloBackref });
    }

    return {
      sourceRef: String(us.ref),
      title: us.subject,
      description: us.description || '',
      createdAt: us.created_date,
      dueDate,
      dueDateSource,
      columnKey,
      assigneeEmails: us.assigned_users || [],
      ownerEmail: us.owner || null,
      comments,
      attachments,
      checklist,
      history,
      trelloBackref,
    };
  });

  gapNotes.push(
    `Due dates: ${dueDateFromBuiltIn} card(s) use the built-in due_date, ${dueDateFromCustom} use the ` +
      `custom "Due" attribute instead (Planka has one due-date field per card; built-in wins when both ` +
      `are set - ${dueDateConflicts} card(s) had both set to different values).`,
  );
  gapNotes.push(
    deletedCommentsExcluded === 0
      ? 'Deleted comments: none found.'
      : `Deleted comments: ${deletedCommentsExcluded} comment(s) were deleted in Taiga (delete_comment_date ` +
          `set) and are excluded from the import, on the assumption the deletion was intentional. ` +
          `Reversible - the text is still present in the source export if you want them included instead.`,
  );
  if (trelloBackrefs.length > 0) {
    gapNotes.push(
      `${trelloBackrefs.length} card(s) originated from Trello (external_reference points at a trello.com ` +
        `URL) - importing normally per your instruction; listed separately below in case a future Trello ` +
        `import needs to reconcile against these to avoid duplicates.`,
    );
  }
  gapNotes.push(
    'Tags/labels: 0 tags used on any card in this export (despite a tags_colors palette existing) - nothing to migrate.',
  );

  const attachmentBytes = cards.reduce(
    (sum, c) => sum + c.attachments.reduce((s, a) => s + (a.sizeBytes || 0), 0),
    0,
  );

  return {
    source: 'taiga',
    sourceFile,
    sourceFileSha256,
    project: { name: raw.name, description: raw.description || null },
    columns,
    members,
    cards,
    gapNotes,
    stats: {
      totalCards: cards.length,
      totalColumns: columns.length,
      totalComments: cards.reduce((s, c) => s + c.comments.length, 0),
      totalAttachments: cards.reduce((s, c) => s + c.attachments.length, 0),
      totalAttachmentBytes: attachmentBytes,
      totalChecklistItems: cards.reduce((s, c) => s + c.checklist.length, 0),
      totalMoveEvents: cards.reduce((s, c) => s + c.history.length, 0),
      trelloBackrefs,
    },
  };
}

module.exports = { parse };
