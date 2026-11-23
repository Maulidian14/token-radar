// Launch Radar v7 — the token-radar-01 entrypoint (Node, standard library only).
//
// Reads the sealed snapshot (/input/snapshot.json, or --input <file|dir>),
// ranks the launch candidates with the model in lib/model.ts, and writes:
//   /output/board.json    the ranked board (rows 1..N by expected value)
//   /output/data.js       the dashboard's dataset (window.RADAR)
//   /output/dashboard/    this repository's dashboard/ page, plus zdata.js:
//                         the snapshot, compact, so the page refits the
//                         model in the browser and checks itself against
//                         board.json — the judge reads this refit.
//   /output/screenshots/  this repository's screenshots/
//   /output/dossier.json  the dossier the judge reads, via vendor/makefun-board.ts
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The run is deterministic: the model reads only the snapshot and its own
// constants, so two runs write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, compactSnapshotScript, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The gate's caps, as the dossier library takes them. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name value` or `--name=value` out of the arguments. */
function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`launch radar: ${message}\n`);
  process.exit(1);
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory tree of regular files into `to`, skipping dot-names. Returns the files copied, by relative path. */
function copyTree(from: string, to: string, prefix = ''): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      copied.push(...copyTree(src, join(to, name), `${prefix}${name}/`));
    } else if (st.isFile()) {
      copyFileSync(src, join(to, name));
      copied.push(`${prefix}${name}`);
    }
  }
  return copied;
}

const pageFiles = copyTree(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
if (!pageFiles.includes('index.html')) fail('dashboard/ holds no index.html');
if (!pageFiles.some((f) => f.endsWith('.css'))) fail('dashboard/ holds no .css file');
if (!pageFiles.some((f) => f.endsWith('.js'))) fail('dashboard/ holds no .js file');

// The snapshot, compact, for the page's in-browser refit. Written after the
// copy so it is never stale, and named to sort last in the dossier — the
// model code is read before the data it fits on.
const zdata = compactSnapshotScript(snapshot);
writeFileSync(join(outDir, 'dashboard', 'zdata.js'), zdata);
pageFiles.push('zdata.js');

const shots = copyTree(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols in the snapshot, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked\n` +
    `launch radar: board seal ${radar.seal}; wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${pageFiles.length} dashboard files (zdata.js ${zdata.length} bytes), ${shots.length} screenshots and ${join(outDir, 'dossier.json')}\n`,
);
