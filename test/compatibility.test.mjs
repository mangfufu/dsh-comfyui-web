import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import semver from 'semver';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('both DSH compatibility policies accept the tested hosts and reject untested releases', () => {
  // 0.2.0 checks DSH peers; 0.2.1 prefers engines.dsh. Both include prereleases.
  const ranges = [manifest.engines.dsh, ...Object.entries(manifest.peerDependencies)
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    .map(([, range]) => range)];
  for (const range of ranges) {
    assert.ok(semver.validRange(range), `invalid range: ${range}`);
    for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.2-rc.1']) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `${version}: ${range}`);
    }
    for (const version of ['0.1.0', '0.2.1-alpha.5', '0.2.2-rc.5', '0.3.0']) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, `${version}: ${range}`);
    }
  }
});

