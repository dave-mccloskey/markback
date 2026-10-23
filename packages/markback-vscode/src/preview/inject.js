// Markback — markdown preview injection.
// Runs inside the VS Code markdown preview's webview. Plain JS, no
// module imports.
//
// Responsibilities:
//  - Render a floating "💬 Comment" button when the user selects
//    text in the preview (v0.2.0).
//  - Render 💬 badges next to lines that have existing comments,
//    using the JSON payload embedded by markdownItPlugin (v0.2.1).
//  - Detect untrusted-workspace state and signal the user when
//    command URI clicks would silently fail (v0.2.1).
//
// One-way bridge through the extension URI handler (command: links are blocked).

// Pure helper (no DOM): given a textarea value and a caret index, return the
// index to which an Alt+Backspace word-delete should extend leftward — i.e.
// the start of the word to remove. Whitespace-delimited: eat the run of
// whitespace immediately left of the caret, then eat the contiguous run of
// non-whitespace before it. Defined at module top-level (not inside the IIFE)
// and exported via the node tail at the bottom of this file so it can be
// unit-tested under `node --test` without a browser. The webview uses it as a
// plain global; node never enters the IIFE (the `typeof window` guard returns
// first) but does pick up the export.
function markbackIsSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function markbackWordDeleteStart(text, caret) {
  var i = caret;
  if (i > text.length) i = text.length;
  if (i < 0) i = 0;
  while (i > 0 && markbackIsSpace(text.charAt(i - 1))) i--;
  while (i > 0 && !markbackIsSpace(text.charAt(i - 1))) i--;
  return i;
}

(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.__markback_preview_injected__) return;
  window.__markback_preview_injected__ = true;

  var SOURCE_URI = resolveSourceUri();
  var TRUSTED = detectTrusted();

  if (!SOURCE_URI) {
    console.log("[markback] could not resolve source URI; preview commenting disabled");
    return;
  }

  if (!TRUSTED) {
    console.log("[markback] workspace appears untrusted; command URIs may be blocked");
    showTrustBanner();
  }

  var BUTTON_ID = "markback-preview-button";
  var button = null;

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("selectionchange", scheduleMaybeShow);
  window.addEventListener("vscode.markdown.updateContent", refreshPayloadDecorations);
  watchInitialPreviewHydration();

  function onMouseDown(e) {
    if (!button) return;
    if (e.target === button || (button.contains && button.contains(e.target))) return;
    removeButton();
  }

  function onMouseUp(_e) {
    scheduleMaybeShow();
  }

  var scheduled = false;
  function scheduleMaybeShow() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      maybeShowButton();
    }, 50);
  }

  function maybeShowButton() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      removeButton();
      return;
    }
    var range = sel.getRangeAt(0);
    if (isInsideButton(range.startContainer) || isInsideButton(range.endContainer)) {
      return;
    }
    var lines = lineRangeForSelection(range);
    if (lines === null) {
      removeButton();
      return;
    }
    var selectionText = sel.toString();
    if (!selectionText || selectionText.trim().length === 0) {
      removeButton();
      return;
    }
    showButton(range, lines, selectionText);
  }

  function isInsideButton(node) {
    while (node) {
      if (node.id === BUTTON_ID) return true;
      if (node.classList && node.classList.contains("markback-badge")) return true;
      if (node.classList && node.classList.contains("markback-bubble")) return true;
      node = node.parentNode;
    }
    return false;
  }

  function lineFor(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    while (node) {
      if (node.getAttribute) {
        var v = node.getAttribute("data-line");
        if (v !== null && v !== "") {
          var n = parseInt(v, 10);
          if (!isNaN(n)) return n;
        }
      }
      node = node.parentNode;
    }
    return null;
  }

  function lineRangeForSelection(range) {
    var startLine = lineFor(range.startContainer);
    var endLine = lineFor(range.endContainer);
    if (startLine === null && endLine === null) return null;
    if (startLine === null) startLine = endLine;
    if (endLine === null) endLine = startLine;
    if (startLine > endLine) {
      var t = startLine;
      startLine = endLine;
      endLine = t;
    }
    return { startLine: startLine, endLine: endLine };
  }

  function previewUri(action, args) {
    var payload = readPayload();
    if (!payload || !payload.endpoint) return null;
    var url = new URL(payload.endpoint);
    url.searchParams.set("action", action);
    url.searchParams.set("args", JSON.stringify(args));
    return url.toString();
  }

  function showButton(range, lines, selectionText) {
    if (!button) {
      button = document.createElement("a");
      button.id = BUTTON_ID;
      button.className = "markback-preview-button";
      button.textContent = "💬 Comment";
      button.setAttribute("role", "button");
      document.body.appendChild(button);
    }
    var rect = range.getBoundingClientRect();
    var top = window.scrollY + rect.top - 36;
    if (rect.top < 40) top = window.scrollY + rect.bottom + 8;
    var left = window.scrollX + rect.right - 100;
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    button.style.top = top + "px";
    button.style.left = left + "px";

    var args = {
      sourceUri: SOURCE_URI,
      startLine: lines.startLine,
      endLine: lines.endLine,
      selectionText: truncate(selectionText, 200),
    };
    var href = previewUri("previewComment", args);
    if (!href) { removeButton(); return; }
    button.setAttribute("href", href);
  }

  function removeButton() {
    if (button && button.parentNode) {
      button.parentNode.removeChild(button);
    }
    button = null;
  }

  function truncate(s, n) {
    if (!s) return "";
    s = s.replace(/\s+/g, " ").trim();
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }

  // ---------- v0.2.1: badges for existing records ----------

  function readPayload() {
    var el = document.getElementById("markback-preview-data");
    if (!el) return null;
    try {
      return JSON.parse(el.getAttribute("data-payload") || "{}");
    } catch (e) {
      console.log("[markback] failed to parse preview-data payload:", e);
      return null;
    }
  }

  function watchInitialPreviewHydration() {
    var root = document.documentElement || document;
    if (typeof MutationObserver === "undefined") {
      if (document.readyState === "loading" || document.readyState === "uninitialized") {
        document.addEventListener("DOMContentLoaded", refreshPayloadDecorations, { once: true });
      } else {
        refreshPayloadDecorations();
      }
      return;
    }

    var observer = new MutationObserver(function () {
      if (!hasInitialPreviewContent()) return;
      observer.disconnect();
      refreshPayloadDecorations();
    });
    observer.observe(root, { childList: true, subtree: true });
    if (hasInitialPreviewContent()) {
      observer.disconnect();
      refreshPayloadDecorations();
    }
  }

  function hasInitialPreviewContent() {
    return !!document.getElementById("markback-preview-data") &&
      !!document.querySelector(".markdown-body");
  }

  function refreshPayloadDecorations() {
    var badges = document.querySelectorAll(".markback-badge");
    for (var i = 0; i < badges.length; i++) {
      if (badges[i].parentNode) badges[i].parentNode.removeChild(badges[i]);
    }
    dismissBubble();

    var payload = readPayload();
    if (payload && payload.records && payload.records.length > 0) {
      renderBadges(payload.records);
    }
  }

  // Group records by their root parent (records with replyTo chain up
  // to a parent that has a real anchor). Returns { byParent, recordsById }.
  function indexRecords(records) {
    var byId = {};
    for (var i = 0; i < records.length; i++) byId[records[i].id] = records[i];
    var byParent = {}; // parentId -> [parent, ...replies in order]
    function rootOf(r) {
      var cursor = r;
      var visited = {};
      while (cursor && cursor.replyTo && !visited[cursor.id]) {
        visited[cursor.id] = true;
        var next = byId[cursor.replyTo];
        if (!next) return null;
        cursor = next;
      }
      if (cursor && !cursor.replyTo && cursor.startLine >= 0) return cursor;
      return null;
    }
    for (var j = 0; j < records.length; j++) {
      var r = records[j];
      var root = rootOf(r);
      if (!root) continue;
      if (!byParent[root.id]) byParent[root.id] = [];
      // Preserve original document order; first entry is the parent
      // (added when we first encounter it).
      byParent[root.id].push(r);
    }
    // Ensure parent is always first in each group.
    var groups = [];
    for (var pid in byParent) {
      if (!Object.prototype.hasOwnProperty.call(byParent, pid)) continue;
      var list = byParent[pid];
      list.sort(function (a, b) {
        if (a.id === pid) return -1;
        if (b.id === pid) return 1;
        return 0;
      });
      groups.push({ parent: list[0], thread: list });
    }
    return groups;
  }

  function renderBadges(records) {
    var groups = indexRecords(records);
    for (var i = 0; i < groups.length; i++) {
      renderBadgeForGroup(groups[i]);
    }
  }

  // Find the rendered element whose [data-line] matches the parent's
  // startLine. The markdown extension emits data-line on block
  // elements; for line N in source, the matching element is the one
  // whose data-line <= N (the immediately-preceding block boundary).
  function findElementForLine(line) {
    // Try exact match first.
    var nodes = document.querySelectorAll("[data-line]");
    var bestNode = null;
    var bestLine = -1;
    for (var i = 0; i < nodes.length; i++) {
      var v = parseInt(nodes[i].getAttribute("data-line"), 10);
      if (isNaN(v)) continue;
      if (v === line) return nodes[i];
      if (v < line && v > bestLine) {
        bestNode = nodes[i];
        bestLine = v;
      }
    }
    return bestNode;
  }

  function renderBadgeForGroup(group) {
    var parent = group.parent;
    var el = findElementForLine(parent.startLine);
    if (!el) {
      console.log("[markback] no DOM element for record at line", parent.startLine);
      return;
    }
    var badge = document.createElement("span");
    badge.className = "markback-badge";
    badge.textContent = "💬" + (group.thread.length > 1 ? group.thread.length : "");
    badge.title = previewSummary(group.thread);
    badge.setAttribute("data-markback-parent-id", parent.id);
    badge.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleBubble(badge, group);
    });
    el.appendChild(badge);
  }

  function previewSummary(thread) {
    var lines = [];
    for (var i = 0; i < thread.length; i++) {
      var r = thread[i];
      var who = r.author || "unknown";
      var body = (r.body || "").replace(/\s+/g, " ").trim();
      if (body.length > 80) body = body.slice(0, 79) + "…";
      lines.push(who + ": " + body);
    }
    return lines.join("\n");
  }

  // ---------- v0.2.2: inline thread bubble ----------

  var activeBubble = null;
  var activeBadge = null;

  document.addEventListener("mousedown", function (e) {
    if (!activeBubble) return;
    if (e.target === activeBubble || (activeBubble.contains && activeBubble.contains(e.target))) return;
    if (e.target === activeBadge) return;
    dismissBubble();
  }, true);

  document.addEventListener("keydown", function (e) {
    if (activeBubble && (e.key === "Escape" || e.keyCode === 27)) {
      dismissBubble();
    }
  });

  function toggleBubble(badge, group) {
    if (activeBubble && activeBadge === badge) {
      dismissBubble();
      return;
    }
    dismissBubble();
    showBubble(badge, group);
  }

  function dismissBubble() {
    if (activeBubble && activeBubble.parentNode) {
      activeBubble.parentNode.removeChild(activeBubble);
    }
    activeBubble = null;
    activeBadge = null;
  }

  function showBubble(badge, group) {
    var bubble = document.createElement("div");
    bubble.className = "markback-bubble";

    var header = document.createElement("div");
    header.className = "markback-bubble-header";
    header.textContent = "Markback thread";
    bubble.appendChild(header);

    for (var i = 0; i < group.thread.length; i++) {
      bubble.appendChild(renderBubbleComment(group.thread[i], i === 0));
    }

    bubble.appendChild(renderReplyForm(group));

    var footer = document.createElement("div");
    footer.className = "markback-bubble-footer";

    var openLink = document.createElement("a");
    openLink.className = "markback-bubble-action";
    openLink.textContent = "Open in .mb";
    openLink.setAttribute("href",
      previewUri("previewOpenSidecar", { sourceUri: SOURCE_URI, recordId: group.parent.id }) || "#");
    footer.appendChild(openLink);

    bubble.appendChild(footer);

    // Position below the badge, clamped to viewport.
    document.body.appendChild(bubble);
    positionBubble(bubble, badge);

    activeBubble = bubble;
    activeBadge = badge;
  }

  function renderBubbleComment(r, isParent) {
    var wrap = document.createElement("div");
    wrap.className = isParent ? "markback-bubble-comment markback-bubble-parent" : "markback-bubble-comment markback-bubble-reply";

    var meta = document.createElement("div");
    meta.className = "markback-bubble-meta";
    meta.textContent = (r.author || "unknown") + (isParent ? "" : " replied");
    wrap.appendChild(meta);

    var body = document.createElement("div");
    body.className = "markback-bubble-body";
    body.textContent = r.body || "";
    wrap.appendChild(body);

    return wrap;
  }

  function renderReplyForm(group) {
    var wrap = document.createElement("div");
    wrap.className = "markback-bubble-reply-form";

    var input = document.createElement("textarea");
    input.className = "markback-bubble-input";
    input.rows = 2;
    input.placeholder = "Reply...";
    wrap.appendChild(input);

    var row = document.createElement("div");
    row.className = "markback-bubble-reply-row";

    var hint = document.createElement("span");
    hint.className = "markback-bubble-reply-hint";
    hint.textContent = "Enter to send · Shift+Enter newline · Alt+Backspace deletes a word";
    row.appendChild(hint);

    var submit = document.createElement("a");
    submit.className = "markback-bubble-submit";
    submit.setAttribute("role", "button");
    submit.textContent = "Reply";
    row.appendChild(submit);

    wrap.appendChild(row);

    function updateReplyHref() {
      var text = (input.value || "").trim();
      if (text.length > 2000) {
        // Command URIs encode all args; keep the URL manageable.
        text = text.slice(0, 2000);
      }
      var url = previewUri("previewReply", {
          sourceUri: SOURCE_URI,
          parentId: group.parent.id,
          text: text,
        });
      if (url && text.length > 0) submit.setAttribute("href", url);
      else submit.removeAttribute("href");
    }

    input.addEventListener("input", updateReplyHref);
    updateReplyHref();

    input.addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.keyCode === 13) && !e.shiftKey) {
        e.preventDefault();
        updateReplyHref();
        if (submit.hasAttribute("href")) submit.click();
        return;
      }
      // Alt+Backspace deletes the previous word. A plain webview <textarea>
      // does not get this for free on Linux/Windows (only Ctrl+Backspace is
      // native there), so we own it. Ctrl/Cmd+Backspace are left to native.
      if ((e.key === "Backspace" || e.keyCode === 8) && e.altKey && !e.ctrlKey && !e.metaKey) {
        var start = input.selectionStart;
        var end = input.selectionEnd;
        if (start === null || start === undefined) return; // host doesn't expose selection — let native run
        // With a selection, delete exactly the selection (like native Backspace);
        // otherwise delete back to the previous word boundary.
        var from = (start !== end) ? start : markbackWordDeleteStart(input.value, start);
        if (from === end) { e.preventDefault(); return; }  // nothing to delete (caret at 0)
        e.preventDefault();
        input.setSelectionRange(from, end);
        // execCommand preserves the textarea's native undo stack; assigning
        // input.value directly would wipe it. Fall back to a direct splice
        // only if execCommand is unavailable.
        var ok = false;
        try { ok = document.execCommand("delete", false); } catch (err) { ok = false; }
        if (!ok) {
          var v = input.value;
          input.value = v.slice(0, from) + v.slice(end);
          input.setSelectionRange(from, from);
        }
      }
    });

    return wrap;
  }

  function positionBubble(bubble, badge) {
    var rect = badge.getBoundingClientRect();
    bubble.style.position = "absolute";
    // Anchor below the badge by default.
    var top = window.scrollY + rect.bottom + 6;
    var left = window.scrollX + rect.left;
    // Render off-screen first to measure, then clamp.
    bubble.style.visibility = "hidden";
    bubble.style.top = "0px";
    bubble.style.left = "0px";
    var bRect = bubble.getBoundingClientRect();
    var viewportRight = window.scrollX + window.innerWidth - 12;
    if (left + bRect.width > viewportRight) {
      left = Math.max(window.scrollX + 8, viewportRight - bRect.width);
    }
    var viewportBottom = window.scrollY + window.innerHeight - 12;
    if (top + bRect.height > viewportBottom) {
      // Try above the badge.
      var altTop = window.scrollY + rect.top - bRect.height - 6;
      if (altTop >= window.scrollY + 8) top = altTop;
    }
    bubble.style.top = top + "px";
    bubble.style.left = left + "px";
    bubble.style.visibility = "";
  }

  // ---------- v0.2.1: trust detection + banner ----------

  function detectTrusted() {
    // VS Code adds vscode-trusted / vscode-untrusted class on body
    // for untrusted workspaces in many versions. Also exposes
    // window.isTrusted indirectly via the data attributes. Be lax:
    // if any signal says untrusted, assume untrusted.
    var body = document.body;
    if (body && body.classList) {
      if (body.classList.contains("vscode-untrusted")) return false;
    }
    var html = document.documentElement;
    if (html && html.classList && html.classList.contains("vscode-untrusted")) {
      return false;
    }
    // Default optimistic.
    return true;
  }

  function showTrustBanner() {
    var banner = document.createElement("div");
    banner.className = "markback-trust-banner";
    banner.textContent =
      "Markback: preview commenting is disabled in Restricted Mode. " +
      "Trust this workspace to enable.";
    document.body.appendChild(banner);
  }

  // ---------- source URI resolution ----------

  function resolveSourceUri() {
    var meta = document.getElementById("vscode-markdown-preview-data");
    if (meta) {
      var attrs = ["data-state", "data-settings", "data-source", "data-resource"];
      for (var i = 0; i < attrs.length; i++) {
        var raw = meta.getAttribute(attrs[i]);
        if (!raw) continue;
        var uri = extractUriFromBlob(raw);
        if (uri) return uri;
      }
    }
    var body = document.body;
    if (body) {
      var direct = body.getAttribute("data-source") || body.getAttribute("data-resource");
      if (direct) return direct;
    }
    return null;
  }

  function extractUriFromBlob(raw) {
    try {
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      if (typeof obj.source === "string") return obj.source;
      if (typeof obj.resource === "string") return obj.resource;
      for (var k in obj) {
        if (typeof obj[k] === "object" && obj[k] !== null) {
          var sub = obj[k].source || obj[k].resource;
          if (typeof sub === "string") return sub;
        }
      }
    } catch (_e) {
      // not JSON
    }
    return null;
  }
})();

// Node-only test hook. In the webview `module` is undefined, so this is skipped
// and the functions above remain plain browser globals. Under `node --test` the
// IIFE returns early (no `window`) and only these pure helpers are exported.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    wordDeleteStart: markbackWordDeleteStart,
    isSpace: markbackIsSpace,
  };
}
