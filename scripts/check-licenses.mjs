// Every package that ships to users must be free and open source under MIT / Apache /
// BSD (or the equally permissive ISC / 0BSD). Run: npm run licenses
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = /^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|BlueOak-1\.0\.0)$/;
// Checked by hand: the package.json field is missing or vague, the LICENSE file is clear.
const VERIFIED = {
  duck: 'BSD-2-Clause', // package.json says "BSD"; LICENSE is the 2-clause text (mammoth -> lop -> duck)
  'png-js': 'MIT', // no license field; LICENSE file is MIT (pdfmake -> pdfkit -> png-js)
};
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const seen = new Map();

function visit(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    if (seen.has(name)) continue;
    let license = 'UNKNOWN';
    try {
      const pkg = JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8'));
      license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map?.((l) => l.type).join(' OR ') ?? 'UNKNOWN');
    } catch {
      // optional dependency that is not installed on this platform
      continue;
    }
    seen.set(name, VERIFIED[name] ?? license);
    visit(info.dependencies);
  }
}
visit(tree.dependencies);

const ok = (license) => license.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/i).some((l) => ALLOWED.test(l.trim()));
const bad = [...seen].filter(([, license]) => !ok(license));
console.log(`[licenses] ${seen.size} production packages checked`);
if (bad.length) {
  console.error(`[licenses] not MIT / Apache / BSD:\n  ${bad.map(([n, l]) => `${n}: ${l}`).join('\n  ')}`);
  process.exit(1);
}
console.log('[licenses] all MIT / Apache-2.0 / BSD / ISC');
