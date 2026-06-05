// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// openclaw-tui-markdown-fix.js — keep fenced code blocks and inline code spans
// verbatim in the OpenClaw TUI.
//
// Problem (NemoClaw#4849):
//   The OpenClaw TUI renders assistant markdown through `marked`. Inline
//   bold/italic formatting (`__text__` -> bold, `_text_` -> italic) is applied
//   to text that lives inside fenced code blocks and inline code spans, so
//   Python dunder syntax is corrupted before it reaches the screen:
//     `if __name__ == "__main__":`  ->  `if name == "main":`
//     `def is_palindrome(...)`       ->  `def is` / `_palindrome(...)`
//   The raw inference.local response is correct; only the client-side render is
//   wrong. The CommonMark spec explicitly excludes emphasis parsing inside code
//   spans/blocks, so the fix is to render code tokens verbatim.
//
// Fix:
//   `marked` already tokenises code spans and fenced blocks into `codespan` /
//   `code` tokens whose `text` is the verbatim source, but the bundled TUI
//   renderer re-applies emphasis to that text. This preload reasserts the
//   correct behavior at the `marked` boundary by replacing the renderer's
//   `code` and `codespan` methods (both on `Renderer.prototype` and via
//   `marked.use({ renderer })`) with faithful implementations that emit the
//   token's verbatim text and never run emphasis over it. Plain paragraph text
//   is untouched, so normal bold/italic outside code keeps working.
//
//   The patch hooks `Module._load` rather than `require('marked')` directly
//   because `marked` is resolved from the OpenClaw install's nested
//   node_modules, which this preload (loaded from /tmp via NODE_OPTIONS) cannot
//   resolve on its own. It is idempotent and a no-op for any consumer that
//   already renders code verbatim.
//
// Source boundary / removal contract:
//   NemoClaw owns the sandbox entrypoint and preload layer but does not vendor
//   the OpenClaw TUI renderer, which is installed into the sandbox at runtime.
//   This preload is the source-boundary workaround. Remove it (and its wiring
//   in scripts/nemoclaw-start.sh) once the bundled OpenClaw TUI renders code
//   spans/blocks verbatim on its own. Verify by rendering
//   `if __name__ == "__main__":` inside a fenced block in `openclaw tui`
//   without this preload and confirming the underscores survive.
//
// Ref: https://github.com/NVIDIA/NemoClaw/issues/4849

(function () {
  'use strict';

  if (process.__nemoclawOpenclawTuiMarkdownFixInstalled) return;
  try {
    Object.defineProperty(process, '__nemoclawOpenclawTuiMarkdownFixInstalled', {
      value: true,
    });
  } catch (_e) {
    process.__nemoclawOpenclawTuiMarkdownFixInstalled = true;
  }

  // Pull the verbatim source text out of a marked code/codespan token. marked
  // v15 passes a token object ({ type, raw, text, lang }); older shapes pass
  // the raw string directly. `text` is the un-emphasised source for code
  // tokens, so it is always preferred over `raw` (which still carries the
  // surrounding backticks / fences).
  function verbatimCodeText(token) {
    if (token && typeof token === 'object') {
      if (typeof token.text === 'string') return token.text;
      if (typeof token.raw === 'string') return token.raw;
      return '';
    }
    return token == null ? '' : String(token);
  }

  function faithfulCodespan(token) {
    return verbatimCodeText(token);
  }

  function faithfulCode(token) {
    return verbatimCodeText(token);
  }

  // Replace the code/codespan renderer methods on a renderer-like object so
  // they emit verbatim source. Returns true if anything was patched.
  function patchRendererObject(renderer) {
    if (!renderer || (typeof renderer !== 'object' && typeof renderer !== 'function')) {
      return false;
    }
    if (renderer.__nemoclawCodeVerbatimPatched) return false;

    var patched = false;
    if (typeof renderer.codespan === 'function') {
      renderer.codespan = faithfulCodespan;
      patched = true;
    }
    if (typeof renderer.code === 'function') {
      renderer.code = faithfulCode;
      patched = true;
    }
    if (patched) {
      try {
        Object.defineProperty(renderer, '__nemoclawCodeVerbatimPatched', { value: true });
      } catch (_e) {
        renderer.__nemoclawCodeVerbatimPatched = true;
      }
    }
    return patched;
  }

  // Patch the `marked` module in place: the default Renderer prototype (covers
  // consumers that subclass or instantiate it) and, when available, register a
  // renderer extension via marked.use() (covers marked.parse()/marked()).
  function applyMarkdownCodeFix(marked) {
    if (!marked || marked.__nemoclawCodeVerbatimPatched) return marked;

    var Renderer = marked.Renderer || (marked.marked && marked.marked.Renderer);
    if (Renderer && Renderer.prototype) {
      patchRendererObject(Renderer.prototype);
    }

    var useFn =
      typeof marked.use === 'function'
        ? marked.use
        : marked.marked && typeof marked.marked.use === 'function'
          ? marked.marked.use
          : null;
    if (useFn) {
      try {
        useFn.call(marked.marked || marked, {
          renderer: { code: faithfulCode, codespan: faithfulCodespan },
        });
      } catch (_e) {
        // marked.use can reject unknown extension shapes on exotic forks;
        // the prototype patch above is the primary path, so swallow and move on.
      }
    }

    try {
      Object.defineProperty(marked, '__nemoclawCodeVerbatimPatched', { value: true });
    } catch (_e) {
      marked.__nemoclawCodeVerbatimPatched = true;
    }
    return marked;
  }

  var Module = require('module');
  var origLoad = Module._load;

  Module._load = function (request, _parent, _isMain) {
    var loaded = origLoad.apply(this, arguments);
    if (request === 'marked') {
      try {
        return applyMarkdownCodeFix(loaded);
      } catch (_e) {
        return loaded;
      }
    }
    return loaded;
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__testing = {
      applyMarkdownCodeFix: applyMarkdownCodeFix,
      patchRendererObject: patchRendererObject,
      faithfulCode: faithfulCode,
      faithfulCodespan: faithfulCodespan,
      verbatimCodeText: verbatimCodeText,
    };
  }
})();
