const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const MarkdownIt = require('markdown-it');
const {buildMarkdownItPlugin} = require('../dist/markdownItPlugin');

test('preview data is attached when the document URI arrives at render time', () => {
  const endpoint = 'vscode://dandriscoll.markback-vscode/preview?nonce=test&extra="<tag>"';
  const md = new MarkdownIt();
  md.use(buildMarkdownItPlugin(null, endpoint));
  const tokens = md.parse('# Review', {currentDocument:undefined});
  const html = md.renderer.render(tokens, md.options, {currentDocument:{fsPath:'/tmp/nonexistent-review.md'}});
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  try {
    const payloadElement = dom.window.document.getElementById('markback-preview-data');
    assert.ok(payloadElement, 'rendered preview must carry its payload element');
    assert.equal(JSON.parse(payloadElement.getAttribute('data-payload')).endpoint, endpoint);
  } finally {
    dom.window.close();
  }
});

test('preview payload survives VS Code hydration that recreates script elements without ids', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  try {
    const md = new MarkdownIt();
    md.use(buildMarkdownItPlugin(null, 'vscode://dandriscoll.markback-vscode/preview?nonce=test'));
    const tokens = md.parse('# Review', {currentDocument:undefined});
    const html = md.renderer.render(tokens, md.options, {currentDocument:{fsPath:'/tmp/nonexistent-review.md'}});
    const parsed = new dom.window.DOMParser().parseFromString(html, 'text/html');
    const renderedRoots = [...parsed.body.children];
    dom.window.document.body.append(...renderedRoots);

    // The installed markdown preview re-creates every script while appending
    // rendered HTML, but only carries these attributes through to the new node.
    for (const root of renderedRoots) {
      const oldScripts = root.tagName === 'SCRIPT' ? [root] : [...root.getElementsByTagName('script')];
      for (const oldScript of oldScripts) {
        const replacement = dom.window.document.createElement('script');
        replacement.textContent = oldScript.textContent;
        for (const attr of ['type', 'src', 'nonce', 'noModule', 'async']) {
          const value = oldScript.getAttribute(attr);
          if (value) replacement.setAttribute(attr, value);
        }
        oldScript.insertAdjacentElement('afterend', replacement);
        oldScript.remove();
      }
    }

    const payloadElement = dom.window.document.getElementById('markback-preview-data');
    assert.ok(payloadElement, 'preview payload must remain addressable after script rehydration');
    assert.equal(
      JSON.parse(payloadElement.getAttribute('data-payload')).endpoint,
      'vscode://dandriscoll.markback-vscode/preview?nonce=test',
    );
  } finally {
    dom.window.close();
  }
});
