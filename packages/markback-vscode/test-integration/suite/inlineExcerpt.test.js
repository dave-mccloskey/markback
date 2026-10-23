const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

// Issue #10: a comment saved on a manageable selection embeds the literal source
// text as inline content under @file; a large selection stays range-only. This
// drives the real user path — select text, commentSelection → draft, saveComment
// — and asserts the bytes that land on disk. (Runtime: Electron; CI/operator-run.
// The agent sandbox cannot launch the VS Code test host — missing libgtk-3.so.0.)

const EXT_ID = "dandriscoll.markback-vscode";

let tempDir;

async function getTestApi() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} not found`);
  const exports = ext.isActive ? ext.exports : await ext.activate();
  assert.ok(exports && exports._testApi, "extension did not return _testApi");
  return exports._testApi;
}

async function waitFor(predicate, timeoutMs = 5000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function openPlain(tag, content) {
  const filepath = path.join(tempDir, `x10-${tag}-${Date.now()}.txt`);
  await fs.writeFile(filepath, content, "utf8");
  const uri = vscode.Uri.file(filepath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  return { editor, uri, filepath };
}

// Drive a real save through the draft path: select text, run commentSelection,
// then run saveComment with the CommentReply VS Code would build. The caller must
// select on a line that ALREADY hosts a comment, so commentSelection routes to our
// draft path (the native add-comment flow only toggles on an occupied line — #9)
// and a tracked draft thread exists to save against.
async function saveCommentOnSelection(api, editor, uri, selection, text) {
  editor.selection = selection;
  await vscode.commands.executeCommand("markback.commentSelection");
  const ok = await waitFor(() => api.hasDraftForSource(uri));
  assert.ok(ok, "expected a draft thread (select on an already-commented line)");
  const thread = api.draftThreadForSource(uri);
  assert.ok(thread, "draft thread must be exposed for the save");
  await vscode.commands.executeCommand("markback.saveComment", { thread, text });
}

before(async function () {
  this.timeout(30000);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "markback-x10-"));
});

after(async () => {
  if (tempDir) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("#10 — inline excerpt in generated .mb", function () {
  this.timeout(20000);

  it("a manageable selection embeds the literal source text as inline content", async () => {
    const api = await getTestApi();
    // Seed an existing comment on line 0 so commentSelection routes to the draft
    // path (the native flow only toggles on an occupied line — issue #9).
    const src = path.join(tempDir, `seed-${Date.now()}.txt`);
    await fs.writeFile(src, "the quick brown fox\n", "utf8");
    await fs.writeFile(
      `${src}.mb`,
      "%markback 2\n\n@id seed1\n@file ./" + path.basename(src) + ":1:1-1:4 <<< existing\n",
      "utf8",
    );
    const uri = vscode.Uri.file(src);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await waitFor(() => api.persistedThreadCountForSource(uri) >= 1);

    await saveCommentOnSelection(
      api,
      editor,
      uri,
      new vscode.Selection(0, 4, 0, 9), // "quick"
      "awkward",
    );

    const ok = await waitFor(async () => {
      const text = await fs.readFile(`${src}.mb`, "utf8");
      return /\n\nquick\n<<< awkward/.test(text);
    });
    const text = await fs.readFile(`${src}.mb`, "utf8");
    assert.ok(ok, `expected inline content "quick" in sidecar; got:\n${text}`);
  });

  it("a large selection (beyond maxLines) stays range-only", async () => {
    const api = await getTestApi();
    await vscode.workspace
      .getConfiguration("markback")
      .update("inlineExcerpt.maxLines", 3, vscode.ConfigurationTarget.Global);
    try {
      const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
      const src = path.join(tempDir, `big-${Date.now()}.txt`);
      await fs.writeFile(src, lines + "\n", "utf8");
      await fs.writeFile(
        `${src}.mb`,
        "%markback 2\n\n@id seed2\n@file ./" + path.basename(src) + ":5:1-5:4 <<< existing\n",
        "utf8",
      );
      const uri = vscode.Uri.file(src);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      await waitFor(() => api.persistedThreadCountForSource(uri) >= 1);

      await saveCommentOnSelection(
        api,
        editor,
        uri,
        new vscode.Selection(0, 0, 5, 0), // 5 lines > maxLines=3
        "too big",
      );

      const text = await fs.readFile(`${src}.mb`, "utf8");
      // A large selection must produce a COMPACT range-only record: `@file
      // <path>:<range> <<< too big` on one line, with no embedded source lines.
      assert.ok(
        /@file \.\/[^\n]*<<< too big/.test(text),
        `large selection must write a compact range-only record; got:\n${text}`,
      );
      assert.ok(
        !/\n\nline 0\n/.test(text),
        `large selection must NOT embed content; got:\n${text}`,
      );
    } finally {
      await vscode.workspace
        .getConfiguration("markback")
        .update("inlineExcerpt.maxLines", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
