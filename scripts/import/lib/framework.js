// Source-agnostic import framework. Consumes the normalized model produced
// by an adapter (see adapters/taiga.js for the contract) and provides:
//   - gap-analysis (counts + member matching against live Planka users)
//   - dry-run (report exactly what would be created, no API calls)
//   - apply (idempotent creation via the import_entities manifest table)
//   - verifyCounts (source vs destination counts after an apply)
// A future Trello adapter would produce the same model shape and reuse all
// four of these unchanged.
const db = require('./db');

// aliases: { sourceEmail: plankaEmail } - manual override for a person who
// signed up to Planka with a different email than the one they used in the
// source system (Taiga), so a plain email === email match can never find
// them automatically. Deliberately explicit/manual (see
// email-aliases.json) rather than any kind of fuzzy name matching - same
// "resolve manually, no auto-create" philosophy as the rest of this tool.
function matchMembers(model, plankaUsers, aliases = {}) {
  const byEmail = new Map(plankaUsers.map((u) => [String(u.email || '').toLowerCase(), u]));
  const normalizedAliases = new Map(
    Object.entries(aliases).map(([from, to]) => [from.toLowerCase(), to.toLowerCase()]),
  );
  const matched = [];
  const unmatched = [];
  for (const m of model.members) {
    const sourceEmail = m.email.toLowerCase();
    const aliasEmail = normalizedAliases.get(sourceEmail);
    const u = byEmail.get(sourceEmail) || (aliasEmail && byEmail.get(aliasEmail));
    if (u) {
      matched.push({ email: m.email, name: m.name, plankaId: u.id, plankaName: u.name, viaAlias: !!aliasEmail && !byEmail.get(sourceEmail) });
    } else {
      unmatched.push(m);
    }
  }
  return { matched, unmatched };
}

function gapAnalysis(model, plankaUsers, aliases = {}) {
  const memberMatches = matchMembers(model, plankaUsers, aliases);

  const cardsWithUnmatchedAssignee = model.cards.filter((c) =>
    c.assigneeEmails.some((e) => memberMatches.unmatched.some((u) => u.email === e)),
  ).length;

  const lines = [];
  lines.push(`# Gap analysis - ${model.source} import: "${model.project.name}"`);
  lines.push('');
  lines.push('## Counts');
  lines.push(`- Columns (Kanban lists): ${model.stats.totalColumns}`);
  lines.push(`- Cards: ${model.stats.totalCards}`);
  lines.push(`- Comments: ${model.stats.totalComments}`);
  lines.push(`- Attachments: ${model.stats.totalAttachments} (${(model.stats.totalAttachmentBytes / 1e6).toFixed(1)} MB total)`);
  lines.push(`- Checklist items: ${model.stats.totalChecklistItems}`);
  lines.push(`- Move-history events (for cycle-time seeding): ${model.stats.totalMoveEvents}`);
  lines.push(`- Members referenced: ${model.members.length} (${memberMatches.matched.length} matched to existing PLANKA accounts, ${memberMatches.unmatched.length} unmatched)`);
  const aliasMatches = memberMatches.matched.filter((m) => m.viaAlias);
  if (aliasMatches.length > 0) {
    lines.push(
      `  (${aliasMatches.length} matched via a manual email alias in email-aliases.json: ` +
        `${aliasMatches.map((m) => `${m.email} -> ${m.plankaName}`).join(', ')})`,
    );
  }
  lines.push('');
  lines.push('## Columns, in order');
  for (const c of model.columns) {
    const n = model.cards.filter((card) => card.columnKey === c.key).length;
    lines.push(`- ${c.name} (${n} card${n === 1 ? '' : 's'})`);
  }
  lines.push('');
  lines.push('## What will NOT carry over / needs your attention');
  for (const note of model.gapNotes) lines.push(`- ${note}`);
  if (cardsWithUnmatchedAssignee > 0) {
    lines.push(
      `- ${cardsWithUnmatchedAssignee} card(s) have an assignee with no matching PLANKA account - ` +
        `those specific assignments will be skipped (card itself still imports).`,
    );
  }
  lines.push('- Comments: for an author with a matched Planka account, the comment is posted as ' +
    'that real user (via a per-user API key, generated fresh and not stored) with the original ' +
    'text unchanged. For a still-unmatched author, it falls back to the PLANKA service account, ' +
    'prefixed with the original author + date, since Planka\'s API cannot otherwise post a ' +
    'comment "as" another user. Run --reauthor-comments after more members sign up to ' +
    'retroactively re-post already-imported service-account comments as their now-matched real ' +
    'author (note: this deletes + recreates the comment, so its createdAt becomes the ' +
    'reauthor time, not the original Taiga date).');
  lines.push('');
  lines.push('## Unmatched members (resolve manually - no auto-create)');
  if (memberMatches.unmatched.length === 0) {
    lines.push('None - every referenced member matched an existing PLANKA account.');
  } else {
    for (const u of memberMatches.unmatched) {
      lines.push(`- ${u.name} <${u.email}>${u.hasMembershipRecord ? '' : ' (no Taiga membership record either - referenced only on a card)'}`);
    }
  }
  if (model.stats.trelloBackrefs.length > 0) {
    lines.push('');
    lines.push(`## Cards that originated from Trello (${model.stats.trelloBackrefs.length}) - check for duplicates if/when Trello import runs`);
    for (const t of model.stats.trelloBackrefs) {
      lines.push(`- [ref ${t.ref}] ${t.title} - ${t.url}`);
    }
  }

  return { memberMatches, reportText: lines.join('\n') };
}

function planDryRun(model, memberMatches) {
  const matchedEmails = new Set(memberMatches.matched.map((m) => m.email));
  const lines = [];
  lines.push(`# Dry run - ${model.source} import: "${model.project.name}"`);
  lines.push('(Nothing was written. This is exactly what --apply would create.)');
  lines.push('');
  lines.push(`Would create project "${model.project.name}" (type: shared) with 1 board "${model.project.name}".`);
  lines.push(`Would create ${model.columns.length} lists, in this order:`);
  for (const c of model.columns) lines.push(`  - ${c.name}`);
  lines.push('');

  let totalAssignments = 0;
  let totalSkippedAssignments = 0;
  let totalComments = 0;
  let totalAttachments = 0;
  let totalChecklistItems = 0;

  for (const card of model.cards) {
    const assigned = card.assigneeEmails.filter((e) => matchedEmails.has(e));
    const skipped = card.assigneeEmails.filter((e) => !matchedEmails.has(e));
    totalAssignments += assigned.length;
    totalSkippedAssignments += skipped.length;
    totalComments += card.comments.length;
    totalAttachments += card.attachments.length;
    totalChecklistItems += card.checklist.length;
  }

  lines.push(`Would create ${model.cards.length} cards.`);
  lines.push(`Would create ${totalAssignments} card assignments (${totalSkippedAssignments} skipped - unmatched member).`);
  lines.push(`Would create ${totalComments} comments (attributed via text prefix, posted by the service account).`);
  lines.push(`Would upload ${totalAttachments} attachments (${(model.stats.totalAttachmentBytes / 1e6).toFixed(1)} MB).`);
  lines.push(`Would create ${totalChecklistItems} checklist items across cards that have Taiga tasks.`);
  lines.push(`Would seed ${model.stats.totalMoveEvents} cycle-time events into planka_ops.cycle_time_events.`);
  lines.push('');
  lines.push('First 10 cards, as a sample:');
  for (const card of model.cards.slice(0, 10)) {
    lines.push(`  [${card.sourceRef}] "${card.title}" -> column "${card.columnKey}", ${card.comments.length} comment(s), ${card.attachments.length} attachment(s), ${card.checklist.length} checklist item(s)`);
  }

  return { reportText: lines.join('\n') };
}

async function apply(model, memberMatches, { plankaClient, token, pool }) {
  const matchedByEmail = new Map(memberMatches.matched.map((m) => [m.email, m.plankaId]));
  const source = model.source;
  const sha = model.sourceFileSha256;

  async function getOrCreate(entityType, sourceRef, createFn) {
    const existing = await db.getEntity(pool, { source, entityType, sourceRef });
    if (existing) return { id: existing, reused: true };
    const created = await createFn();
    await db.recordEntity(pool, { source, sourceFileSha256: sha, entityType, sourceRef, plankaId: created.id });
    return { id: created.id, reused: false };
  }

  // In-memory only, never persisted - regenerated fresh every run rather
  // than stored, so there's no live user credential sitting in our own
  // planka_ops DB. Each POST /users/:id/api-key call overwrites that user's
  // existing key (Planka only supports one active key per user); see the
  // caveat on plankaClient.createUserApiKey.
  const apiKeyCache = new Map();
  async function ensureApiKey(userId) {
    if (!apiKeyCache.has(userId)) {
      apiKeyCache.set(userId, await plankaClient.createUserApiKey(userId, token));
    }
    return apiKeyCache.get(userId);
  }

  const result = { created: {}, reused: {}, updated: {}, skippedSync: {}, skippedAssignments: 0, failedAttachments: [] };
  const bump = (bucket, key) => {
    result[bucket][key] = (result[bucket][key] || 0) + 1;
  };

  const project = await getOrCreate('project', 'project', () =>
    plankaClient.createProject({ name: model.project.name, description: model.project.description, type: 'shared' }, token));
  bump(project.reused ? 'reused' : 'created', 'project');

  const board = await getOrCreate('board', 'board', () =>
    plankaClient.createBoard(project.id, { name: model.project.name, position: 65536 }, token));
  bump(board.reused ? 'reused' : 'created', 'board');

  const listIdByColumnKey = new Map();
  for (const [i, col] of model.columns.entries()) {
    const list = await getOrCreate('list', col.key, () =>
      plankaClient.createList(board.id, { name: col.name, position: (i + 1) * 65536, type: 'active' }, token));
    bump(list.reused ? 'reused' : 'created', 'list');
    listIdByColumnKey.set(col.key, list.id);
  }

  // Card-memberships require the target user to already be a board member
  // (confirmed: card-memberships/create.js checks isBoardMember and 404s
  // otherwise) - ensure editor access up front for every matched member who
  // is actually an assignee somewhere, so this run is self-sufficient and
  // doesn't depend on someone having separately run batch-assign first.
  // Also covers comment authors, not just assignees: comments/create.js
  // rejects a non-board-member with a disguised "Card not found" (really
  // Forbidden) when posting as a specific real user via API key, and a
  // comment author isn't necessarily also an assignee anywhere.
  const assigneeEmailsUsed = new Set([
    ...model.cards.flatMap((c) => c.assigneeEmails),
    ...model.cards.flatMap((c) => c.comments.map((cm) => cm.authorEmail)),
  ]);
  for (const email of assigneeEmailsUsed) {
    const userId = matchedByEmail.get(email);
    if (!userId) continue;
    try {
      const bm = await getOrCreate('board_membership', email, () =>
        plankaClient.createBoardMembership(board.id, userId, 'editor', token));
      bump(bm.reused ? 'reused' : 'created', 'board_membership');
    } catch (err) {
      // Already a board member through some other path (e.g. manually
      // added via the Share modal, or a re-run picking up someone who
      // signed up between runs and was added by a project manager in the
      // meantime, not by this tool) - not a failure, this step's goal
      // (the user has board access) is already satisfied. Record it so
      // future re-runs don't retry the same doomed create call.
      if (err.status === 409) {
        await db.recordEntity(pool, {
          source,
          sourceFileSha256: sha,
          entityType: 'board_membership',
          sourceRef: email,
          plankaId: userId,
        });
        bump('reused', 'board_membership');
      } else {
        throw err;
      }
    }
  }

  // For cards already imported by a prior run, sync fields that may have
  // changed in a newer re-export of the same source project (title,
  // description, due date, column) - fetched once up front rather than
  // per-card, since GET /boards/:id already returns full card records.
  const existingBoardState = await plankaClient.getBoard(board.id, token);
  const existingCardById = new Map((existingBoardState.included.cards || []).map((c) => [c.id, c]));
  const normalizeDate = (value) => (value ? new Date(value).getTime() : null);
  const nextPositionCache = new Map();
  const nextPositionInList = async (targetListId) => {
    if (!nextPositionCache.has(targetListId)) {
      const cardsInList = await plankaClient.getCardsInList(targetListId, token);
      const maxPosition = cardsInList.reduce((max, c) => Math.max(max, c.position || 0), 0);
      nextPositionCache.set(targetListId, maxPosition);
    }
    const position = nextPositionCache.get(targetListId) + 65536;
    nextPositionCache.set(targetListId, position);
    return position;
  };

  for (const [i, card] of model.cards.entries()) {
    const listId = listIdByColumnKey.get(card.columnKey);
    const cardRes = await getOrCreate('card', card.sourceRef, () =>
      plankaClient.createCard(listId, {
        name: card.title,
        description: card.description,
        position: (i + 1) * 65536,
        dueDate: card.dueDate,
      }, token));
    bump(cardRes.reused ? 'reused' : 'created', 'card');
    const cardId = cardRes.id;

    if (cardRes.reused) {
      const existing = existingCardById.get(cardId);
      if (existing) {
        const patch = {};
        if (existing.name !== card.title) patch.name = card.title;
        if ((existing.description || '') !== (card.description || '')) patch.description = card.description;
        if (normalizeDate(existing.dueDate) !== normalizeDate(card.dueDate)) {
          // dueDate has no allowNull on the input side (see createCard) -
          // only send it when there's an actual value to set.
          if (card.dueDate) patch.dueDate = card.dueDate;
        }
        if (existing.listId !== listId) {
          patch.listId = listId;
          patch.boardId = board.id;
          patch.position = await nextPositionInList(listId);
        }
        if (Object.keys(patch).length > 0) {
          // Don't blindly overwrite - if the live card was touched more
          // recently than the last time THIS TOOL touched it (creation or a
          // prior sync), someone (real staff, most likely) has interacted
          // with it since, and a field-level diff can't tell a stale export
          // value apart from a deliberate edit. Confirmed the hard way: a
          // rerun once silently reverted a staff member's real card move -
          // see CLAUDE.md "Taiga import: re-running --apply clobbered a
          // real staff card move (2026-08-13)". Prefer leaving a stale
          // field over risking a silent revert; the gap gets surfaced in
          // the apply report for a human to look at instead.
          //
          // Note this is intentionally coarse: ANY card activity (a new
          // comment, a task list, a member add) bumps card.updatedAt, not
          // just name/description/column edits, so this will also skip
          // syncs that would have been perfectly safe. That false-skip is
          // the acceptable failure mode here - a stale field is recoverable
          // by hand, a silently clobbered edit usually isn't.
          const cardEntity = await db.getEntityRecord(pool, { source, entityType: 'card', sourceRef: card.sourceRef });
          const lastToolTouch = cardEntity ? cardEntity.updatedAt : null;
          const liveUpdatedAt = existing.updatedAt ? new Date(existing.updatedAt) : null;

          if (lastToolTouch && liveUpdatedAt && liveUpdatedAt > lastToolTouch) {
            result.skippedSyncs = result.skippedSyncs || [];
            result.skippedSyncs.push({ cardRef: card.sourceRef, title: card.title, patchFields: Object.keys(patch) });
            bump('skippedSync', 'card');
          } else {
            await plankaClient.updateCard(cardId, patch, token);
            // Bump this tool's own last-touch record so a future rerun's
            // comparison baseline reflects this sync, not the original
            // creation time.
            await db.recordEntity(pool, { source, sourceFileSha256: sha, entityType: 'card', sourceRef: card.sourceRef, plankaId: cardId });
            bump('updated', 'card');
          }
        }
      }
    }

    for (const email of card.assigneeEmails) {
      const userId = matchedByEmail.get(email);
      if (!userId) {
        result.skippedAssignments += 1;
        continue;
      }
      try {
        const m = await getOrCreate('card_membership', `${card.sourceRef}:${email}`, () =>
          plankaClient.createCardMembership(cardId, userId, token));
        bump(m.reused ? 'reused' : 'created', 'card_membership');
      } catch (err) {
        result.failedAssignments = result.failedAssignments || [];
        result.failedAssignments.push({ cardRef: card.sourceRef, email, error: err.message });
      }
    }

    for (const [ci, comment] of card.comments.entries()) {
      const authorUserId = matchedByEmail.get(comment.authorEmail);
      // When the original author now has a matched Planka account, post
      // the comment as them (via a fresh, in-memory-only API key) with the
      // original unprefixed text - real attribution instead of "the invite
      // service said this on your behalf". Falls back to the service
      // account + text prefix for still-unmatched authors, same as before.
      const c = await getOrCreate('comment', `${card.sourceRef}:${ci}`, async () => {
        if (authorUserId) {
          const apiKey = await ensureApiKey(authorUserId);
          return plankaClient.createComment(cardId, comment.text, token, { apiKey });
        }
        const text = `_[originally posted by ${comment.authorName} <${comment.authorEmail}> on ${comment.createdAt}]_\n\n${comment.text}`;
        return plankaClient.createComment(cardId, text, token);
      });
      bump(c.reused ? 'reused' : 'created', 'comment');
    }

    if (card.checklist.length > 0) {
      const taskList = await getOrCreate('task_list', card.sourceRef, () =>
        plankaClient.createTaskList(cardId, { name: 'Checklist', position: 65536 }, token));
      bump(taskList.reused ? 'reused' : 'created', 'task_list');
      for (const [ti, item] of card.checklist.entries()) {
        const t = await getOrCreate('task', `${card.sourceRef}:${ti}`, () =>
          plankaClient.createTask(taskList.id, { name: item.text, position: (ti + 1) * 65536, isCompleted: item.isCompleted }, token));
        bump(t.reused ? 'reused' : 'created', 'task');
      }
    }

    for (const [ai, att] of card.attachments.entries()) {
      const existing = await db.getEntity(pool, { source, entityType: 'attachment', sourceRef: `${card.sourceRef}:${ai}` });
      if (existing) {
        bump('reused', 'attachment');
        continue;
      }
      try {
        const buffer = Buffer.from(att.base64, 'base64');
        const created = await plankaClient.createFileAttachment(cardId, { name: att.name, buffer }, token);
        await db.recordEntity(pool, { source, sourceFileSha256: sha, entityType: 'attachment', sourceRef: `${card.sourceRef}:${ai}`, plankaId: created.id });
        bump('created', 'attachment');
      } catch (err) {
        result.failedAttachments.push({ cardRef: card.sourceRef, name: att.name, error: err.message });
      }
    }

    for (const ev of card.history) {
      await db.recordCycleTimeEvent(pool, {
        source,
        sourceFileSha256: sha,
        cardSourceRef: card.sourceRef,
        cardPlankaId: cardId,
        eventType: ev.fromColumnKey ? 'moved' : 'created',
        fromListName: ev.fromColumnKey ? (model.columns.find((c) => c.key === ev.fromColumnKey) || {}).name : null,
        toListName: (model.columns.find((c) => c.key === ev.toColumnKey) || {}).name || null,
        occurredAt: ev.at,
      });
    }
  }

  return { result, boardId: board.id };
}

// One-time (but idempotent) retroactive fix for comments that were already
// imported by apply() back when their author had no matching Planka
// account yet - reposts them as the now-matched real user instead of the
// service account, dropping the "[originally posted by X]" prefix since
// it's genuinely them now. Deliberately a separate, explicitly-invoked mode
// from --apply (see cli.js --reauthor-comments) rather than folded into
// every apply() run, since it deletes + recreates real comments: the new
// comment gets a new id and Planka sets createdAt at recreation time, so
// the original historical timestamp is NOT preserved. Confirmed idempotent
// via a 'comment_reauthor' marker row per comment - safe to rerun as more
// members sign up, already-fixed comments are skipped.
async function reauthorComments(model, memberMatches, { plankaClient, token, pool }) {
  const matchedByEmail = new Map(memberMatches.matched.map((m) => [m.email, m.plankaId]));
  const source = model.source;
  const sha = model.sourceFileSha256;
  const boardId = await db.getEntity(pool, { source, entityType: 'board', sourceRef: 'board' });

  const apiKeyCache = new Map();
  async function ensureApiKey(userId) {
    if (!apiKeyCache.has(userId)) {
      apiKeyCache.set(userId, await plankaClient.createUserApiKey(userId, token));
    }
    return apiKeyCache.get(userId);
  }

  // A comment author isn't necessarily a card assignee, so apply()'s
  // up-front "ensure editor access" pass (scoped to assigneeEmailsUsed)
  // won't have granted them board membership - and comments/create.js
  // rejects a non-member with a misleadingly-worded "Card not found"
  // (really a disguised Forbidden). Found this the hard way: 8 comments hit
  // it, and because delete-then-create used to run in that order, the
  // failure happened *after* the original had already been deleted -
  // silent, confirmed data loss (332 -> 326 comments on the Yapmaster
  // board). Grant membership up front here too, same idempotent
  // create-or-409-is-fine pattern apply() already uses for assignees.
  const boardMembershipGranted = new Set();
  async function ensureBoardMembership(userId) {
    if (boardMembershipGranted.has(userId)) return;
    try {
      await plankaClient.createBoardMembership(boardId, userId, 'editor', token);
    } catch (err) {
      if (err.status !== 409) throw err;
    }
    boardMembershipGranted.add(userId);
  }

  const result = { reauthored: 0, alreadyReauthored: 0, stillUnmatched: 0, notYetImported: 0, failed: [] };

  for (const card of model.cards) {
    let cardPlankaId = null;

    for (const [ci, comment] of card.comments.entries()) {
      const authorUserId = matchedByEmail.get(comment.authorEmail);
      if (!authorUserId) {
        result.stillUnmatched += 1;
        continue;
      }

      const sourceRef = `${card.sourceRef}:${ci}`;

      const marker = await db.getEntity(pool, { source, entityType: 'comment_reauthor', sourceRef });
      if (marker) {
        result.alreadyReauthored += 1;
        continue;
      }

      const oldCommentId = await db.getEntity(pool, { source, entityType: 'comment', sourceRef });
      if (!oldCommentId) {
        // apply() hasn't imported this comment yet (e.g. a brand new export
        // row) - nothing to reauthor; a future apply() run will already
        // post it correctly-attributed via the forward-looking check.
        result.notYetImported += 1;
        continue;
      }

      if (!cardPlankaId) {
        cardPlankaId = await db.getEntity(pool, { source, entityType: 'card', sourceRef: card.sourceRef });
      }
      if (!cardPlankaId) {
        result.failed.push({ cardRef: card.sourceRef, commentRef: sourceRef, error: 'card not found in import_entities' });
        continue;
      }

      try {
        await ensureBoardMembership(authorUserId);
        const apiKey = await ensureApiKey(authorUserId);

        // Create the correctly-attributed comment FIRST, and only delete
        // the old one once that succeeds - if createComment throws, the
        // original stays intact instead of being lost. This is the fix for
        // the data-loss bug above.
        const created = await plankaClient.createComment(cardPlankaId, comment.text, token, { apiKey });

        try {
          await plankaClient.deleteComment(oldCommentId, token);
        } catch (delErr) {
          // Already gone - e.g. this exact comment hit the pre-fix bug on
          // an earlier run (deleted, then failed to recreate). The goal
          // state (one correctly-attributed comment with this text exists)
          // is met either way; a missing delete target isn't a failure.
          if (delErr.status !== 404) throw delErr;
        }

        // Overwrite the comment entity to point at the new id, and drop a
        // marker so a rerun skips this one - both via the same upsert path
        // getOrCreate/recordEntity already use elsewhere.
        await db.recordEntity(pool, { source, sourceFileSha256: sha, entityType: 'comment', sourceRef, plankaId: created.id });
        await db.recordEntity(pool, { source, sourceFileSha256: sha, entityType: 'comment_reauthor', sourceRef, plankaId: created.id });
        result.reauthored += 1;
      } catch (err) {
        result.failed.push({ cardRef: card.sourceRef, commentRef: sourceRef, error: err.message });
      }
    }
  }

  return result;
}

async function verifyCounts(model, plankaClient, token, boardId) {
  const board = await plankaClient.getBoard(boardId, token);
  const { lists, cards, tasks, attachments } = board.included;

  const lines = [];
  lines.push(`# Count verification - board "${model.project.name}"`);
  lines.push('');

  const srcCards = model.cards.length;
  const dstCards = cards.length;
  lines.push(`Cards: source ${srcCards} vs destination ${dstCards} ${srcCards === dstCards ? 'OK' : 'MISMATCH'}`);

  const srcChecklist = model.stats.totalChecklistItems;
  const dstChecklist = tasks.length;
  lines.push(`Checklist items: source ${srcChecklist} vs destination ${dstChecklist} ${srcChecklist === dstChecklist ? 'OK' : 'MISMATCH'}`);

  const srcAttachments = model.stats.totalAttachments;
  const dstAttachments = attachments.length;
  lines.push(`Attachments: source ${srcAttachments} vs destination ${dstAttachments} ${srcAttachments === dstAttachments ? 'OK' : 'MISMATCH'}`);

  lines.push('');
  lines.push('Per-column card counts:');
  const listById = new Map(lists.map((l) => [l.id, l]));
  const cardsByListName = new Map();
  for (const c of cards) {
    const name = (listById.get(c.listId) || {}).name || '(unknown list)';
    cardsByListName.set(name, (cardsByListName.get(name) || 0) + 1);
  }
  for (const col of model.columns) {
    const src = model.cards.filter((c) => c.columnKey === col.key).length;
    const dst = cardsByListName.get(col.name) || 0;
    lines.push(`  ${col.name}: source ${src} vs destination ${dst} ${src === dst ? 'OK' : 'MISMATCH'}`);
  }

  lines.push('');
  lines.push('Comments (not included in GET /boards/:id, fetched per-card):');
  const srcComments = model.stats.totalComments;
  let dstComments = 0;
  for (const card of cards) {
    const cardComments = await plankaClient.getComments(card.id, token);
    dstComments += cardComments.length;
  }
  lines.push(`  source ${srcComments} vs destination ${dstComments} ${srcComments === dstComments ? 'OK' : 'MISMATCH'}`);

  return {
    reportText: lines.join('\n'),
    summary: { srcCards, dstCards, srcChecklist, dstChecklist, srcAttachments, dstAttachments, srcComments, dstComments },
  };
}

module.exports = { matchMembers, gapAnalysis, planDryRun, apply, reauthorComments, verifyCounts };
