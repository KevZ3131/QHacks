'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    RELOAD_PATH,
    injectLiveReload,
    resolveRequestPath,
    shouldIgnore,
} = require('../scripts/dev-server.js');

test('development server resolves root files without allowing traversal', () => {
    const root = path.resolve('/tmp/paperpiano-test-root');

    assert.equal(resolveRequestPath(root, '/'), path.join(root, 'index.html'));
    assert.equal(resolveRequestPath(root, '/css/style.css'), path.join(root, 'css/style.css'));
    assert.equal(resolveRequestPath(root, '/..%2Fsecret.txt'), null);
    assert.equal(resolveRequestPath(root, '/%E0%A4%A'), null);
});

test('development server injects one live-reload event stream client', () => {
    const html = injectLiveReload('<html><body>Paper Piano</body></html>');

    assert.match(html, new RegExp(RELOAD_PATH));
    assert.equal(html.match(/EventSource/g).length, 1);
    assert.ok(html.indexOf('EventSource') < html.indexOf('</body>'));
});

test('development server ignores dependency and Git metadata changes', () => {
    assert.equal(shouldIgnore('node_modules/pkg/index.js'), true);
    assert.equal(shouldIgnore('.git/index'), true);
    assert.equal(shouldIgnore('js/main.js'), false);
});
