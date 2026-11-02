import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceSetting } from '../../scripts/actual-category-cutover.mjs';

test('cutover changes only selected TOML settings', () => {
    const source =
        '[import]\ncategorySync = "new" # comment\nsynchronizeClearedStatus = true\n[payeeTransformation]\nenabled = true\n[import.transfers]\nenabled = true\n';
    const next = replaceSetting(
        replaceSetting(source, 'import', 'categorySync', 'off'),
        'payeeTransformation',
        'enabled',
        false
    );
    assert.match(next, /categorySync = "off"/);
    assert.match(next, /\[payeeTransformation\]\nenabled = false/);
    assert.match(next, /\[import.transfers\]\nenabled = true/);
    assert.match(next, /synchronizeClearedStatus = true/);
    assert.throws(() => replaceSetting(source, 'missing', 'enabled', false));
    assert.throws(() =>
        replaceSetting(
            source.replace(
                'categorySync =',
                'categorySync = "new"\ncategorySync ='
            ),
            'import',
            'categorySync',
            'off'
        )
    );
});
