import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const releaseConfig = JSON.parse(
    readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8')
);

test('semantic-release keeps release rules focused on conventional SemVer gaps', () => {
    const commitAnalyzer = releaseConfig.plugins.find((plugin) => {
        return (
            Array.isArray(plugin) &&
            plugin[0] === '@semantic-release/commit-analyzer'
        );
    });

    assert.ok(commitAnalyzer, 'commit analyzer plugin is configured');

    const [, options] = commitAnalyzer;
    assert.ok(Array.isArray(options.releaseRules));
    assert.deepEqual(options.releaseRules, [
        {
            type: 'refactor',
            release: 'patch',
        },
    ]);
});
