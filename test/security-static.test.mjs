import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const dedupStoreSource = fs.readFileSync(path.join(repoRoot, 'lib', 'dedup-store.js'), 'utf8');

function routeRegistration(method, routePath) {
  const escaped = routePath.replaceAll('/', '\\/');
  const pattern = new RegExp(`app\\.${method}\\(\\s*['\"]${escaped}['\"]([^\\n]*)`);
  const match = serverSource.match(pattern);
  assert.ok(match, `expected ${method.toUpperCase()} ${routePath} route to exist`);
  return match[0];
}

test('only /healthz remains public; every admin/session/debug/action route uses requireAuth middleware', () => {
  const protectedRoutes = [
    ['get', '/'],
    ['get', '/dedup-status'],
    ['post', '/test-crash-notification'],
    ['post', '/test-dedup-notification'],
    ['get', '/switch-headless'],
    ['post', '/transfer-session'],
    ['post', '/debug-verify-login'],
    ['get', '/debug-session'],
    ['post', '/upload-user-data'],
    ['get', '/get-session'],
    ['get', '/confirm-login'],
    ['get', '/init-login'],
    ['post', '/press'],
    ['post', '/sync-from-master'],
    ['post', '/sync-pool'],
    ['post', '/reinit-pool'],
  ];

  for (const [method, routePath] of protectedRoutes) {
    assert.match(routeRegistration(method, routePath), /requireAuth/, `${method.toUpperCase()} ${routePath} must require bearer auth`);
  }

  assert.doesNotMatch(routeRegistration('get', '/healthz'), /requireAuth/, '/healthz must stay public for liveness checks');
});

test('dedup diagnostics are bounded and do not expose raw dedup keys', () => {
  assert.match(serverSource, /DEDUP_STATUS_LIMIT/, 'dedup status must define a response cap');
  assert.match(serverSource, /cleanupDedupStore\(/, 'dedup status must clean expired entries before reporting');
  assert.doesNotMatch(serverSource, /key,\s*\n\s*state:/, 'dedup status must not return raw dedup keys');
  assert.match(dedupStoreSource, /keyDigest/, 'dedup status should expose only a digest for correlation');
});

test('repo sensitive browser artifacts are ignored and not tracked', () => {
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /^user-data-backup\.zip$/m);
  assert.match(gitignore, /^session-data\.json$/m);
  const trackedFiles = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
  assert.ok(!trackedFiles.includes('user-data-backup.zip'), 'user-data-backup.zip must not be tracked');
  assert.ok(!trackedFiles.includes('session-data.json'), 'session-data.json must not be tracked');
});


test('repo does not contain known hardcoded bearer token literals', () => {
  const trackedFiles = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const forbidden = [Buffer.from('7061626c6f6e69636f74696e65706f7563686573', 'hex').toString('utf8'), Buffer.from('6d616e796368617432303234', 'hex').toString('utf8')];
  for (const relPath of trackedFiles) {
    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) continue;
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    for (const token of forbidden) {
      assert.ok(!content.includes(token), `${relPath} must not contain hardcoded bearer token literal`);
    }
  }
});
