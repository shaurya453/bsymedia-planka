// Narrow, read-mostly companion to cli.js --apply: grants board membership
// to newly-matched members (people who now have a real Planka account, e.g.
// signed up since the last full apply run) WITHOUT touching cards, comments,
// checklists, or attachments at all. Reuses framework.matchMembers (the same
// email-matching logic --apply already uses) and the exact same
// assigneeEmailsUsed criterion (assignees + comment authors) --apply's own
// membership-granting step uses, so "who needs board access" stays defined
// in exactly one place.
//
// Usage:
//   node add-members-only.js taiga --file /data/export.json [--dry-run]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const planka = require('./lib/planka-client');
const framework = require('./lib/framework');
const db = require('./lib/db');

function parseArgs(argv) {
  const [adapterName, ...rest] = argv;
  const opts = { adapterName, file: null, dryRun: false };
  for (const arg of rest) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--file') opts.file = rest[rest.indexOf(arg) + 1];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.adapterName || !opts.file) {
    console.error('Usage: node add-members-only.js <adapter> --file <path> [--dry-run]');
    process.exit(1);
  }

  const adapter = require(`./adapters/${opts.adapterName}`);
  const raw = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  const sourceFileSha256 = crypto.createHash('sha256').update(fs.readFileSync(opts.file)).digest('hex');
  const model = adapter.parse(raw, { sourceFile: path.basename(opts.file), sourceFileSha256 });

  const token = await planka.login(process.env.PLANKA_SERVICE_EMAIL, process.env.PLANKA_SERVICE_PASSWORD);
  const plankaUsers = await planka.listUsers(token);

  const aliasesPath = path.join(__dirname, 'email-aliases.json');
  const aliases = fs.existsSync(aliasesPath) ? JSON.parse(fs.readFileSync(aliasesPath, 'utf8')) : {};

  const { memberMatches } = framework.gapAnalysis(model, plankaUsers, aliases);
  const matchedByEmail = new Map(memberMatches.matched.map((m) => [m.email, m]));

  // Exact same criterion apply()'s own membership-granting step uses -
  // people who are actually referenced as a card assignee or a comment
  // author, not the full (possibly-irrelevant) Taiga member roster.
  const assigneeEmailsUsed = new Set([
    ...model.cards.flatMap((c) => c.assigneeEmails),
    ...model.cards.flatMap((c) => c.comments.map((cm) => cm.authorEmail)),
  ]);

  const relevantMatched = [...assigneeEmailsUsed]
    .map((email) => matchedByEmail.get(email))
    .filter(Boolean);

  console.log(`Source: ${model.source}`);
  console.log(`Board-relevant emails (assignee or comment author): ${assigneeEmailsUsed.size}`);
  console.log(`  ...of which matched to a real Planka account: ${relevantMatched.length}`);
  console.log(`  ...of which still unmatched (no Planka account yet): ${assigneeEmailsUsed.size - relevantMatched.length}`);

  const pool = await db.connect();
  try {
    const boardId = await db.getEntity(pool, { source: model.source, entityType: 'board', sourceRef: 'board' });
    if (!boardId) {
      throw new Error(`No board found in import_entities for source "${model.source}" - has this project been imported yet?`);
    }
    console.log(`Board id: ${boardId}`);

    const toGrant = [];
    for (const m of relevantMatched) {
      const already = await db.getEntity(pool, { source: model.source, entityType: 'board_membership', sourceRef: m.email });
      if (!already) toGrant.push(m);
    }

    console.log(`\nNot yet recorded as board members by this tool: ${toGrant.length}`);
    toGrant.forEach((m) => console.log(`  - ${m.plankaName} <${m.email}>`));

    if (opts.dryRun) {
      console.log('\n(--dry-run: nothing was written)');
      return;
    }

    let created = 0;
    let alreadyMember = 0;
    for (const m of toGrant) {
      try {
        await planka.createBoardMembership(boardId, m.plankaId, 'editor', token);
        await db.recordEntity(pool, {
          source: model.source,
          sourceFileSha256,
          entityType: 'board_membership',
          sourceRef: m.email,
          plankaId: m.plankaId,
        });
        created += 1;
        console.log(`Granted board access: ${m.plankaName} <${m.email}>`);
      } catch (err) {
        if (err.status === 409) {
          // Already a member through some other path (manually added, or a
          // race with a prior run) - record it so future runs don't retry.
          await db.recordEntity(pool, {
            source: model.source,
            sourceFileSha256,
            entityType: 'board_membership',
            sourceRef: m.email,
            plankaId: m.plankaId,
          });
          alreadyMember += 1;
        } else {
          console.error(`FAILED for ${m.email}: ${err.message}`);
        }
      }
    }

    console.log(`\nDone. Newly granted: ${created}. Already a member (just recorded): ${alreadyMember}.`);
    console.log('No cards, comments, checklists, or attachments were touched by this run.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
