// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway recovery preload self-heal — generates the shell installer that
// restores the safety-net / ciao --require entries in NODE_OPTIONS when a
// legacy sandbox's proxy-env.sh was emitted before the entrypoint started
// emitting those guards. Lifted out of runtime.ts to keep the recovery
// monolith focused on the surrounding control flow.

// Trust-boundary preload modules. The container image ships the immutable
// originals under /usr/local/lib/nemoclaw/preloads/; the sandbox entrypoint
// stages working copies into /tmp via emit_sandbox_sourced_file() with mode
// 444 (and root:root when launched as root) so the sandbox user can source
// them via NODE_OPTIONS but cannot tamper with the bytes that the Node
// process will load.
export const GATEWAY_PRELOAD_GUARDS: ReadonlyArray<{
  tmpPath: string;
  sourcePath: string;
}> = [
  {
    tmpPath: "/tmp/nemoclaw-sandbox-safety-net.js",
    sourcePath: "/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js",
  },
  {
    tmpPath: "/tmp/nemoclaw-ciao-network-guard.js",
    sourcePath: "/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js",
  },
];

// Self-heal NODE_OPTIONS at recovery time for sandboxes that were onboarded
// by an older entrypoint which did not emit the --require preload lines into
// /tmp/nemoclaw-proxy-env.sh. The whole block is gated on _PE_MISSING="0"
// (proxy-env was sourced successfully) so that the legacy "proxy-env missing
// → launching without library guards" warning still reflects reality.
//
// Provenance is enforced before any path joins NODE_OPTIONS — the staged
// /tmp/<preload>.js must be a regular non-symlink with mode 444 (and root-
// owned when recovery runs as uid 0), matching what emit_sandbox_sourced_file
// writes in scripts/lib/sandbox-init.sh. If the staged copy is missing the
// installer recreates it from the immutable /usr/local/lib/nemoclaw/preloads/
// source using the same atomic-stage-and-rename pattern as the entrypoint.
//
// Every failure mode (symlink, wrong mode, wrong owner, source absent, copy
// failed) skips the entry — it never grafts an untrusted file into
// NODE_OPTIONS. The trailing "refusing unguarded gateway relaunch" invariant
// at the end of the script still fires when provenance gates anything off.
export function buildGatewayPreloadSelfHealLines(): string[] {
  const installer = [
    "_nemoclaw_install_recovery_preload() {",
    'local tmp="$1"; local src="$2"; local dir base stage perms owner _msg;',
    'if [ ! -e "$tmp" ]; then',
    'if [ ! -r "$src" ]; then',
    '_msg="[gateway-recovery] WARNING: $src missing - cannot self-heal $tmp";',
    'echo "$_msg" >&2; [ -n "${_GATEWAY_LOG:-}" ] && echo "$_msg" >> "$_GATEWAY_LOG" 2>/dev/null;',
    "return 1;",
    "fi;",
    'dir="$(dirname -- "$tmp")"; base="$(basename -- "$tmp")";',
    'stage="$(mktemp -- "${dir}/.${base}.tmp.XXXXXX")" || return 1;',
    'if ! cp -- "$src" "$stage"; then rm -f -- "$stage"; return 1; fi;',
    'if [ "$(id -u)" -eq 0 ] && ! chown root:root "$stage"; then rm -f -- "$stage"; return 1; fi;',
    'if ! chmod 444 "$stage"; then rm -f -- "$stage"; return 1; fi;',
    'if ! mv -f -- "$stage" "$tmp"; then rm -f -- "$stage"; return 1; fi;',
    "fi;",
    'if [ -L "$tmp" ]; then',
    '_msg="[gateway-recovery] ERROR: $tmp is a symlink - refusing preload install";',
    'echo "$_msg" >&2; [ -n "${_GATEWAY_LOG:-}" ] && echo "$_msg" >> "$_GATEWAY_LOG" 2>/dev/null;',
    "return 1;",
    "fi;",
    'if [ ! -f "$tmp" ]; then',
    '_msg="[gateway-recovery] ERROR: $tmp is not a regular file - refusing preload install";',
    'echo "$_msg" >&2; [ -n "${_GATEWAY_LOG:-}" ] && echo "$_msg" >> "$_GATEWAY_LOG" 2>/dev/null;',
    "return 1;",
    "fi;",
    'perms="$(stat -c %a -- "$tmp" 2>/dev/null || stat -f %Lp -- "$tmp" 2>/dev/null || echo unknown)";',
    'if [ "$perms" != "444" ]; then',
    '_msg="[gateway-recovery] ERROR: $tmp has unsafe mode=$perms (expected 444) - refusing preload install";',
    'echo "$_msg" >&2; [ -n "${_GATEWAY_LOG:-}" ] && echo "$_msg" >> "$_GATEWAY_LOG" 2>/dev/null;',
    "return 1;",
    "fi;",
    'if [ "$(id -u)" -eq 0 ]; then',
    'owner="$(stat -c %U -- "$tmp" 2>/dev/null || stat -f %Su -- "$tmp" 2>/dev/null || echo unknown)";',
    'if [ "$owner" != "root" ]; then',
    '_msg="[gateway-recovery] ERROR: $tmp owner=$owner (expected root) - refusing preload install";',
    'echo "$_msg" >&2; [ -n "${_GATEWAY_LOG:-}" ] && echo "$_msg" >> "$_GATEWAY_LOG" 2>/dev/null;',
    "return 1;",
    "fi;",
    "fi;",
    'case "${NODE_OPTIONS:-}" in',
    '*"--require $tmp"*) ;;',
    '*) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $tmp" ;;',
    "esac;",
    "return 0;",
    "};",
  ].join(" ");

  const calls = GATEWAY_PRELOAD_GUARDS.map(
    ({ tmpPath, sourcePath }) =>
      `_nemoclaw_install_recovery_preload ${tmpPath} ${sourcePath} || true;`,
  );

  return ['if [ "$_PE_MISSING" = "0" ]; then', installer, ...calls, "fi;"];
}
