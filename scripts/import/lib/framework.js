// Source-agnostic import framework. Consumes the normalized model produced
// by an adapter (see adapters/taiga.js for the contract) and provides:
//   - gap-analysis (counts + member matching against live Planka users)
//   - dry-run (report exactly what would be created, no API calls)
//   - apply (idempotent creation via the import_entities manifest table)
//   - verifyCounts (source vs destination counts after an apply)
// A future Trello adapter would produce the same model shape and reuse all
// four of these unchanged.
const db = require('./db');

function matchMembers(model, plankaUsers) {
  const byEmail = new Map(plankaUsers.map((u) => [String(u.email || '').toLowerCase(), u]));
  const matched = [];
  const unmatched = [];
  for (const m of model.members) {
    const u = byEmail.get(m.email.toLowerCase());
    if (u) {
      matched.push({ email: m.email, name: m.name, plankaId: u.id, plankaName: u.name });
    } else {
      unmatched.push(m);
    }
  }
  return { matched, unmatched };
}

function gapAnalysis(model, plankaUsers) {
  const memberMatches = matchMembers(model, plankaUsers);

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
  lines.push('- Comments: all migrated comments will be posted by the PLANKA service account, ' +
    'prefixed with the original author + date, since PLANKA\'s API cannot post a comment "as" ' +
    'another user (comments/create.js always attributes to the authenticated caller).');
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
    const existing = await db.getEntity(pool, { source, sourceFileSha256: sha, entityType, sourceRef });
    if (existing) return { id: existing, reused: true };
    const created = await createFn();
    await db.recordEntity(pool, { source, sourceFileSha256: sha, entityType, sourceRef, plankaId: created.id });
    return { id: created.id, reused: false };
  }

  const result = { created: {}, reused: {}, skippedAssignments: 0, failedAttachments: [] };
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
  const assigneeEmailsUsed = new Set(model.cards.flatMap((c) => c.assigneeEmails));
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
      const text = `_[originally posted by ${comment.authorName} <${comment.authorEmail}> on ${comment.createdAt}]_\n\n${comment.text}`;
      const c = await getOrCreate('comment', `${card.sourceRef}:${ci}`, () =>
        plankaClient.createComment(cardId, text, token));
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
      const existing = await db.getEntity(pool, { source, sourceFileSha256: sha, entityType: 'attachment', sourceRef: `${card.sourceRef}:${ai}` });
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

module.exports = { matchMembers, gapAnalysis, planDryRun, apply, verifyCounts };
