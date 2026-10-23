const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const MarkdownIt = require("markdown-it");
const { JSDOM } = require("jsdom");

const EXT_ID = "dandriscoll.markback-vscode";

function payloadFromHtml(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  try {
    const payloadElement = dom.window.document.getElementById("markback-preview-data");
    assert.ok(payloadElement, "rendered preview should include its data payload");
    return JSON.parse(payloadElement.getAttribute("data-payload"));
  } finally {
    dom.window.close();
  }
}

describe("Markdown preview plugin registration", function () {
  this.timeout(20000);

  it("exports extendMarkdownIt and renders the real preview endpoint with sidecar data", async () => {
    const extension = vscode.extensions.getExtension(EXT_ID);
    assert.ok(extension, `extension ${EXT_ID} not found`);
    const exports = extension.isActive ? extension.exports : await extension.activate();

    assert.equal(typeof exports.extendMarkdownIt, "function");

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "markback-preview-plugin-"));
    try {
      const sourcePath = path.join(tempDir, "preview.md");
      await fs.writeFile(sourcePath, "# Preview\n", "utf8");
      await fs.writeFile(
        `${sourcePath}.mb`,
        "%markback 2\n\n@id preview-record\n\n@file ./preview.md:1 <<< Preview comment\n",
        "utf8",
      );

      const md = exports.extendMarkdownIt(new MarkdownIt());
      const tokens = md.parse("# Preview\n", { currentDocument: undefined });
      const html = md.renderer.render(tokens, md.options, {
        currentDocument: { fsPath: sourcePath },
      });
      const payload = payloadFromHtml(html);
      assert.equal(payload.records.length, 1);
      assert.equal(payload.records[0].id, "preview-record");
      assert.equal(payload.records[0].body, "Preview comment");
      assert.equal(typeof payload.endpoint, "string");
      assert.ok(payload.endpoint.length > 0, "activation should provide a preview endpoint");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("is applied by VS Code's built-in markdown.api.render command", async () => {
    const extension = vscode.extensions.getExtension(EXT_ID);
    assert.ok(extension, `extension ${EXT_ID} not found`);
    if (!extension.isActive) await extension.activate();

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "markback-markdown-api-"));
    try {
      const sourcePath = path.join(tempDir, "preview.md");
      await fs.writeFile(sourcePath, "# Preview\n", "utf8");
      await fs.writeFile(
        `${sourcePath}.mb`,
        "%markback 2\n\n@id builtin-preview-record\n\n@file ./preview.md:1 <<< Built-in renderer comment\n",
        "utf8",
      );

      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
      const html = await vscode.commands.executeCommand("markdown.api.render", document);
      assert.equal(typeof html, "string", "the built-in renderer should return HTML");
      const payload = payloadFromHtml(html);
      assert.equal(payload.records[0]?.id, "builtin-preview-record");
      assert.equal(payload.records[0]?.body, "Built-in renderer comment");
      assert.equal(typeof payload.endpoint, "string");
      assert.ok(payload.endpoint.length > 0, "activation should provide a preview endpoint");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
