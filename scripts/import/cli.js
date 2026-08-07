// Entry point for the import tool. Run via docker compose (see run.sh) so
// it has network access to `planka` and `postgres` without exposing any
// new ports or touching docker-compose.yml.
//
// Usage (inside the container, or via run.sh from the host):
//   node cli.js taiga --file /data/export.json --gap-analysis
//   node cli.js taiga --file /data/export.json --dry-run
//   node cli.js taiga --file /data/export.json --apply
//   node cli.js taiga --file /data/export.json --verify=<boardId>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const planka = require('./lib/planka-client');
const framework = require('./lib/framework');
const db = require('./lib/db');

function parseArgs(argv) {
  const [adapterName, ...rest] = argv;
  const opts = { adapterName, mode: null, verifyBoardId: null, file: null };
  for (const arg of rest) {
    if (arg === '--gap-analysis') opts.mode = 'gap-analysis';
    else if (arg === '--dry-run') opts.mode = 'dry-run';
    else if (arg === '--apply') opts.mode = 'apply';
    else if (arg.startsWith('--verify=')) {
      opts.mode = 'verify';
      opts.verifyBoardId = arg.split('=')[1];
    } else if (arg === '--file') {
      opts.file = rest[rest.indexOf(arg) + 1];
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.adapterName || !opts.mode || !opts.file) {
    console.error('Usage: node cli.js <adapter> --file <path> [--gap-analysis|--dry-run|--apply|--verify=<boardId>]');
    process.exit(1);
  }

  const adapter = require(`./adapters/${opts.adapterName}`);
  const raw = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  const sourceFileSha256 = crypto.createHash('sha256').update(fs.readFileSync(opts.file)).digest('hex');
  const model = adapter.parse(raw, { sourceFile: path.basename(opts.file), sourceFileSha256 });

  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const writeReport = (name, text) => {
    const p = path.join(reportsDir, name);
    fs.writeFileSync(p, text);
    console.log(`\n--- report written to ${p} ---\n`);
  };

  const token = await planka.login(process.env.PLANKA_SERVICE_EMAIL, process.env.PLANKA_SERVICE_PASSWORD);
  const plankaUsers = await planka.listUsers(token);

  if (opts.mode === 'gap-analysis') {
    const { reportText } = framework.gapAnalysis(model, plankaUsers);
    console.log(reportText);
    writeReport(`${opts.adapterName}-gap-analysis.md`, reportText);
    return;
  }

  if (opts.mode === 'dry-run') {
    const { memberMatches } = framework.gapAnalysis(model, plankaUsers);
    const { reportText } = framework.planDryRun(model, memberMatches);
    console.log(reportText);
    writeReport(`${opts.adapterName}-dry-run.md`, reportText);
    return;
  }

  if (opts.mode === 'apply') {
    const { memberMatches } = framework.gapAnalysis(model, plankaUsers);
    const pool = await db.connect();
    try {
      const { result, boardId } = await framework.apply(model, memberMatches, { plankaClient: planka, token, pool });
      const lines = [
        `# Apply result - ${model.project.name}`,
        `Board id: ${boardId}`,
        `Created: ${JSON.stringify(result.created, null, 2)}`,
        `Reused (already existed from a prior run): ${JSON.stringify(result.reused, null, 2)}`,
        `Skipped assignments (no matching PLANKA account): ${result.skippedAssignments}`,
        `Failed assignments (matched account, but card-membership call still failed): ${JSON.stringify(result.failedAssignments || [], null, 2)}`,
        `Failed attachments: ${JSON.stringify(result.failedAttachments, null, 2)}`,
      ];
      const reportText = lines.join('\n');
      console.log(reportText);
      writeReport(`${opts.adapterName}-apply-result.md`, reportText);
      console.log(`\nRun verification with: node cli.js ${opts.adapterName} --file "${opts.file}" --verify=${boardId}`);
    } finally {
      await pool.end();
    }
    return;
  }

  if (opts.mode === 'verify') {
    const { reportText } = await framework.verifyCounts(model, planka, token, opts.verifyBoardId);
    console.log(reportText);
    writeReport(`${opts.adapterName}-verify.md`, reportText);
    return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
