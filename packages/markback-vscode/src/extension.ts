import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import { AuthorResolver } from "./author";
import { CommentControlPlane } from "./commentControlPlane";
import { OutputLogger } from "./output";
import { SidecarRepository } from "./sidecarRepository";
import { registerCommands } from "./commandLayer";
import { buildMarkdownItPlugin } from "./markdownItPlugin";

let mdPluginLogger: OutputLogger | null = null;
let previewEndpoint: string | undefined;

export type MarkbackTestApi = {
  hasDraftForSource(sourceUri: vscode.Uri): boolean;
  getDraftRangeForSource(sourceUri: vscode.Uri): vscode.Range | null;
  wasFocusHandoffSkipped(sourceUri: vscode.Uri): boolean | null;
  persistedThreadCountForSource(sourceUri: vscode.Uri): number;
  firstCommentForSource(sourceUri: vscode.Uri): vscode.Comment | null;
  draftThreadForSource(sourceUri: vscode.Uri): vscode.CommentThread | null;
  firstPersistedThreadForSource(sourceUri: vscode.Uri): vscode.CommentThread | null;
  hasEditInProgress(): boolean;
};

export async function activate(
  context: vscode.ExtensionContext,
): Promise<{ _testApi: MarkbackTestApi; extendMarkdownIt: typeof extendMarkdownIt }> {
  const channel = vscode.window.createOutputChannel("Markback");
  context.subscriptions.push(channel);
  const logger = new OutputLogger(channel);
  mdPluginLogger = logger;

  // New sidecars follow the editor's files.eol setting; "auto" (or unset)
  // resolves to the OS-native ending. Existing sidecars keep their own EOL.
  const repo = new SidecarRepository(logger, () => {
    const cfg = vscode.workspace.getConfiguration("files").get<string>("eol");
    return cfg === "\r\n" || cfg === "\n" ? cfg : process.platform === "win32" ? "\r\n" : "\n";
  });
  const author = new AuthorResolver(logger);
  const plane = new CommentControlPlane(repo, logger);
  plane.registerSubscriptions(context);

  registerCommands(context, { plane, repo, author, logger });

  // Markdown previews do not enable command: links. Use VS Code routing
  // instead, with a per-activation token and a fixed set of preview actions.
  const nonce = randomUUID();
  const actions = new Set(["previewComment", "previewOpenSidecar", "previewReply"]);
  context.subscriptions.push(vscode.window.registerUriHandler({
    async handleUri(uri) {
      const query = new URLSearchParams(uri.query);
      const action = query.get("action");
      if (uri.path !== "/preview" || query.get("nonce") !== nonce || !action || !actions.has(action)) {
        logger.warn("[preview] rejected invalid preview request");
        return;
      }
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage("Markback: preview commenting requires a trusted workspace.");
        return;
      }
      try {
        const args = JSON.parse(query.get("args") ?? "null");
        if (!args || typeof args.sourceUri !== "string") throw new Error("Missing source URI");
        await vscode.commands.executeCommand("markback." + action, args);
        if (action === "previewComment" || action === "previewReply") {
          await vscode.commands.executeCommand("markdown.preview.refresh");
        }
      } catch (error) {
        logger.error("[preview] " + String(error));
        vscode.window.showErrorMessage("Markback: could not handle preview action. See the Markback output log.");
      }
    },
  }));
  previewEndpoint = (await vscode.env.asExternalUri(vscode.Uri.parse(
    `${vscode.env.uriScheme}://${context.extension.id}/preview?nonce=${nonce}`,
  ))).toString(true);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("markback.author")) {
        author.invalidate();
        logger.info("markback.author setting changed; cached author reset");
      }
    }),
  );

  logger.info("Markback extension v0.2 activated");

  return {
    // VS Code's built-in Markdown extension reads this hook from
    // Extension.exports, which is the value returned from activate().
    extendMarkdownIt,
    _testApi: {
      hasDraftForSource: (uri) => plane.hasDraftForSource(uri),
      getDraftRangeForSource: (uri) => plane.getDraftRangeForSource(uri),
      wasFocusHandoffSkipped: (uri) => plane.wasFocusHandoffSkipped(uri),
      persistedThreadCountForSource: (uri) => plane.persistedThreadCountForSource(uri),
      firstCommentForSource: (uri) => plane.firstCommentForSource(uri),
      draftThreadForSource: (uri) => plane.draftThreadForSource(uri),
      firstPersistedThreadForSource: (uri) => plane.firstPersistedThreadForSource(uri),
      hasEditInProgress: () => plane.hasEditInProgress(),
    },
  };
}

export function deactivate(): void {
  mdPluginLogger = null;
}

// Called by the built-in markdown extension via markdown.markdownItPlugins.
// Returns the modified markdown-it instance with our preview-data plugin
// applied. We embed the current sidecar's records in an escaped data attribute
// at the top of the rendered HTML; inject.js reads them and renders 💬
// badges next to the commented lines.
export function extendMarkdownIt(md: any): any {
  md.use(buildMarkdownItPlugin(mdPluginLogger, previewEndpoint));
  return md;
}
