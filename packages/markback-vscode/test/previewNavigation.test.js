const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// The built-in preview loads preview scripts before it hydrates rendered body
// content. Exercise that ordering, then ensure the selection link reaches the
// extension URI handler after the payload arrives.
test('preview selection reads a payload appended after injection', async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="vscode-markdown-preview-data" data-settings='{"source":"file:///tmp/review.md"}'></div>
  </body>`, {runScripts:'outside-only'});
  try {
    const { window } = dom;
    window.eval(fs.readFileSync(path.join(__dirname,'../src/preview/inject.js'),'utf8'));

    // Mimic the built-in Markdown preview hydrating content after its scripts
    // have run, followed by its documented content-update event.
    const markdownBody = window.document.createElement('div');
    markdownBody.className = 'markdown-body';
    const paragraph = window.document.createElement('p');
    paragraph.setAttribute('data-line','3');
    paragraph.textContent = 'Review this sentence.';
    markdownBody.appendChild(paragraph);
    const payload = window.document.createElement('div');
    payload.id = 'markback-preview-data';
    payload.hidden = true;
    payload.setAttribute('data-payload', JSON.stringify({
      records:[{id:'preview-record',startLine:3,endLine:3,body:'Existing comment',author:null,replyTo:null}],
      endpoint:'vscode://dandriscoll.markback-vscode/preview?nonce=test&windowId=7'
    }));
    markdownBody.insertBefore(payload, paragraph);
    window.document.body.appendChild(markdownBody);
    await Promise.resolve();
    assert.equal(window.document.querySelectorAll('.markback-badge').length, 1,
      'existing comments should render after initial Markdown DOM hydration without an update event');

    window.dispatchEvent(new window.Event('vscode.markdown.updateContent'));
    assert.equal(window.document.querySelectorAll('.markback-badge').length, 1,
      'later content updates should refresh badges without duplication');

    const range = window.document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, paragraph.firstChild.length);
    range.getBoundingClientRect = () => ({top:100,bottom:120,right:300,left:100});
    window.getSelection().addRange(range);
    window.document.dispatchEvent(new window.MouseEvent('mouseup',{bubbles:true}));
    await new Promise(resolve => window.setTimeout(resolve,80));
    const button = window.document.getElementById('markback-preview-button');
    assert.ok(button, 'selecting preview text exposes the comment button');
    const link = new URL(button.href);
    assert.equal(link.protocol,'vscode:');
    assert.equal(link.searchParams.get('windowId'),'7');
    assert.equal(link.searchParams.get('nonce'),'test');
    assert.equal(link.searchParams.get('action'),'previewComment');
    assert.deepEqual(JSON.parse(link.searchParams.get('args')), {
      sourceUri:'file:///tmp/review.md',startLine:3,endLine:3,selectionText:'Review this sentence.'
    });

    window.document.querySelector('.markback-badge').click();
    const replyInput = window.document.querySelector('.markback-bubble-input');
    replyInput.value = 'A reply from the preview';
    replyInput.dispatchEvent(new window.Event('input', {bubbles:true}));
    const replyLink = window.document.querySelector('.markback-bubble-submit');
    let routedTarget = null;
    window.document.addEventListener('click', function (event) {
      const anchor = event.target.closest && event.target.closest('a');
      if (anchor && anchor.href.startsWith('vscode:')) {
        routedTarget = anchor;
        // Stand in for VS Code's host navigation interception in jsdom.
        event.preventDefault();
      }
    }, true);
    replyLink.dispatchEvent(new window.MouseEvent('click', {bubbles:true,cancelable:true}));
    assert.equal(routedTarget, replyLink,
      'VS Code should receive the click on the visible Reply anchor, not a transient link');
    const replyUrl = new URL(routedTarget.href);
    assert.equal(replyUrl.searchParams.get('action'), 'previewReply');
    assert.deepEqual(JSON.parse(replyUrl.searchParams.get('args')), {
      sourceUri:'file:///tmp/review.md',parentId:'preview-record',text:'A reply from the preview'
    });
  } finally {dom.window.close();}
});
