// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CSSProperties } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Tone = "cmd" | "dim" | "info" | "json" | "ok" | "warn";
type PaneKey = "redis" | "gateway" | "openclaw" | "hermes";

type TerminalLine = {
  at: number;
  text: string;
  tone?: Tone;
};

type Stage = {
  frame: number;
  title: string;
  detail: string;
  focus: PaneKey | "bus" | "all";
};

export const DEMO_FPS = 30;
export const TIMELINE_SCALE = 1.18;
export const AUDIO_PLAYBACK_RATE = 1 / TIMELINE_SCALE;
export const DEMO_DURATION_IN_FRAMES = Math.round(140 * DEMO_FPS * TIMELINE_SCALE);

const sec = (seconds: number) => Math.round(seconds * DEMO_FPS * TIMELINE_SCALE);

const stages: Stage[] = [
  {
    frame: sec(0),
    title: "OpenShell shared agent memory",
    detail: "A release handoff between OpenClaw and Hermes, backed by Redis and driven by OpenShell.",
    focus: "all",
  },
  {
    frame: sec(10),
    title: "Redis is the MVP backend",
    detail: "Redis Streams provide a durable append-only event log for this prototype.",
    focus: "redis",
  },
  {
    frame: sec(19),
    title: "OpenShell exposes the driver API",
    detail: "Agents call /v1/memory; OpenShell owns backend credentials and policy.",
    focus: "gateway",
  },
  {
    frame: sec(36),
    title: "Hermes subscribes to release events",
    detail: "Hermes asks for release.* updates in the workspace scope.",
    focus: "hermes",
  },
  {
    frame: sec(50),
    title: "OpenClaw publishes a release blocker",
    detail: "OpenClaw reports that the Hermes adapter smoke path must pass before the MVP demo is ready.",
    focus: "openclaw",
  },
  {
    frame: sec(69),
    title: "The event lands in Redis through OpenShell",
    detail: "Redis sees an XADD; the agents only see the OpenShell memory API.",
    focus: "bus",
  },
  {
    frame: sec(80),
    title: "Hermes pulls its subscription inbox",
    detail: "Pull delivery returns the pending blocker from Hermes' durable release.* subscription.",
    focus: "hermes",
  },
  {
    frame: sec(99),
    title: "Hermes acknowledges progress",
    detail: "Ack state is stored per subscription so the event is not replayed forever.",
    focus: "hermes",
  },
  {
    frame: sec(104),
    title: "Hermes responds with remediation",
    detail: "Hermes publishes release.remediation.planned back into the same scoped memory stream.",
    focus: "hermes",
  },
  {
    frame: sec(118),
    title: "OpenClaw queries the response",
    detail: "OpenClaw can now see Hermes accepted the blocker and knows the release next steps.",
    focus: "openclaw",
  },
  {
    frame: sec(127),
    title: "Value proposition",
    detail: "A reusable driver lets future agents coordinate without coupling to each other.",
    focus: "all",
  },
];

const paneMeta: Record<PaneKey, { title: string; subtitle: string; accent: string }> = {
  redis: {
    title: "Redis",
    subtitle: "stream backend",
    accent: "#ff7b72",
  },
  gateway: {
    title: "OpenShell",
    subtitle: "/v1/memory driver",
    accent: "#3fb950",
  },
  openclaw: {
    title: "OpenClaw agent",
    subtitle: "publisher + query client",
    accent: "#58a6ff",
  },
  hermes: {
    title: "Hermes agent",
    subtitle: "subscriber + responder",
    accent: "#d2a8ff",
  },
};

const terminalLines: Record<PaneKey, TerminalLine[]> = {
  redis: [
    { at: sec(10), tone: "cmd", text: "$ docker run -p 127.0.0.1:16379:6379 redis:7-alpine" },
    { at: sec(12), tone: "ok", text: "Ready to accept connections on 0.0.0.0:6379" },
    { at: sec(69), tone: "info", text: "MONITOR: POST /memory/events accepted" },
    { at: sec(70), tone: "cmd", text: "XADD memory:workspace:nemoclaw-demo *" },
    { at: sec(72), tone: "json", text: "  type=release.blocker.detected" },
    { at: sec(75), tone: "json", text: "  subject=shared-memory-mvp/hermes-adapter-smoke" },
    { at: sec(78), tone: "ok", text: "stream length: 1" },
    { at: sec(108), tone: "cmd", text: "XADD memory:workspace:nemoclaw-demo *" },
    { at: sec(112), tone: "json", text: "  type=release.remediation.planned subject=hermes:demo" },
    { at: sec(116), tone: "ok", text: "stream length: 2" },
    { at: sec(119), tone: "cmd", text: "XRANGE memory:workspace:nemoclaw-demo - +" },
    { at: sec(123), tone: "ok", text: "2 events retained for workspace:nemoclaw-demo" },
  ],
  gateway: [
    { at: sec(19), tone: "cmd", text: "$ cargo run -p openshell-server --bin openshell-gateway" },
    { at: sec(20), tone: "info", text: "OPENSHELL_MEMORY_BACKEND=redis" },
    { at: sec(24), tone: "info", text: "OPENSHELL_MEMORY_REDIS_URL=redis://127.0.0.1:16379" },
    { at: sec(29), tone: "ok", text: "listening on http://127.0.0.1:18080/v1" },
    { at: sec(37), tone: "ok", text: "POST /v1/memory/subscriptions filters=release.* -> 201" },
    { at: sec(64), tone: "ok", text: "POST /v1/memory/events -> 201" },
    { at: sec(67), tone: "json", text: "id=mem_01HXOC_FINDING scope=workspace:nemoclaw-demo" },
    { at: sec(82), tone: "ok", text: "GET /v1/memory/subscriptions/release-shared-memory-hermes/poll -> 200" },
    { at: sec(85), tone: "json", text: "events=1 unacked=1" },
    { at: sec(100), tone: "ok", text: "POST /v1/memory/subscriptions/release-shared-memory-hermes/ack -> 200" },
    { at: sec(108), tone: "ok", text: "POST /v1/memory/events -> 201" },
    { at: sec(113), tone: "json", text: "id=mem_01HXHE_PLAN type=release.remediation.planned" },
    { at: sec(119), tone: "ok", text: "GET /v1/memory/query?type=release.remediation.planned -> 200" },
  ],
  openclaw: [
    { at: sec(2), tone: "dim", text: "$ cd nemoclaw-features/feat-shared-agent-memory" },
    { at: sec(50), tone: "cmd", text: "$ node examples/shared-memory/openclaw-agent.js publish '{...}'" },
    { at: sec(53), tone: "info", text: "Release check: Hermes adapter smoke path must pass before demo." },
    { at: sec(60), tone: "json", text: "event_type: release.blocker.detected" },
    { at: sec(64), tone: "json", text: "subject: shared-memory-mvp/hermes-adapter-smoke" },
    { at: sec(67), tone: "warn", text: "impact: handoff could be missed if subscription path is unverified." },
    { at: sec(69), tone: "ok", text: "recommendation: validate subscribe, pull, ack, and response publishing" },
    { at: sec(72), tone: "ok", text: "published id=mem_01HXOC_FINDING" },
    { at: sec(118), tone: "cmd", text: "$ node openclaw-agent.js query '{\"event_type\":\"release.remediation.planned\"}'" },
    { at: sec(121), tone: "ok", text: "Hermes response found: state=ready_for_validation" },
    { at: sec(124), tone: "json", text: "next_step: run Hermes adapter smoke path" },
    { at: sec(126), tone: "json", text: "next_step: keep Redis behind OpenShell" },
  ],
  hermes: [
    { at: sec(36), tone: "cmd", text: "$ uv --directory ~/hermes-agent run python hermes-agent.py subscribe" },
    { at: sec(38), tone: "json", text: "subscription_id: release-shared-memory-hermes" },
    { at: sec(41), tone: "json", text: "filters: { types: [\"release.*\"] }" },
    { at: sec(45), tone: "ok", text: "subscribed to workspace:nemoclaw-demo" },
    { at: sec(80), tone: "cmd", text: "$ python hermes-agent.py poll '{\"limit\":10}'  # pull inbox" },
    { at: sec(83), tone: "ok", text: "received 1 release blocker from OpenClaw" },
    { at: sec(86), tone: "json", text: "type: release.blocker.detected" },
    { at: sec(89), tone: "json", text: "summary: validate Hermes adapter smoke path" },
    { at: sec(99), tone: "cmd", text: "$ python hermes-agent.py ack mem_01HXOC_FINDING" },
    { at: sec(101), tone: "ok", text: "acknowledged: 1" },
    { at: sec(104), tone: "cmd", text: "$ python hermes-agent.py publish release.remediation.planned" },
    { at: sec(108), tone: "json", text: "state: ready_for_validation" },
    { at: sec(112), tone: "json", text: "plan: run smoke path, preserve driver boundary, publish result" },
    { at: sec(116), tone: "ok", text: "published id=mem_01HXHE_PLAN" },
  ],
};

const captions = [
  {
    from: sec(0),
    to: sec(10),
    text: "This is OpenShell shared agent memory: OpenClaw and Hermes coordinate through an OpenShell driver, backed by Redis.",
  },
  {
    from: sec(10),
    to: sec(19),
    text: "Redis is only the storage backend. The agents never receive Redis credentials.",
  },
  {
    from: sec(19),
    to: sec(31),
    text: "OpenShell is the driver boundary. It exposes /v1/memory and owns policy, schema, and provenance.",
  },
  {
    from: sec(31),
    to: sec(50),
    text: "Hermes subscribes to release updates before it starts working.",
  },
  {
    from: sec(50),
    to: sec(69),
    text: "OpenClaw publishes a concrete release blocker: the Hermes adapter smoke path must pass before the MVP demo is ready.",
  },
  {
    from: sec(69),
    to: sec(80),
    text: "OpenShell persists that event in Redis Streams and keeps the backend hidden behind the memory API.",
  },
  {
    from: sec(80),
    to: sec(99),
    text: "Hermes pulls its subscription inbox and receives the OpenClaw blocker with type, subject, content, and provenance.",
  },
  {
    from: sec(99),
    to: sec(104),
    text: "Hermes acknowledges the event so subscription state remains durable.",
  },
  {
    from: sec(104),
    to: sec(118),
    text: "Hermes publishes a release.remediation.planned event so OpenClaw can see how the blocker will be handled.",
  },
  {
    from: sec(118),
    to: sec(127),
    text: "OpenClaw queries the plan update and the coordination loop is closed.",
  },
  {
    from: sec(127),
    to: sec(140),
    text: "The value is a plug-in shared memory driver: durable, scoped, polyglot, and reusable for future agents.",
  },
];

const valueProps = [
  "Agents share facts without direct process coupling",
  "OpenShell owns Redis credentials, schema, policy, and audit",
  "Subscriptions create durable inboxes; pull delivery is the MVP transport",
  "Adapters stay thin, so future agents can plug into the same API",
];

function activeStage(frame: number): Stage & { index: number } {
  let index = 0;
  for (let i = 0; i < stages.length; i += 1) {
    if (frame >= stages[i].frame) index = i;
  }
  return { ...stages[index], index };
}

function linesForPane(pane: PaneKey, frame: number) {
  const visible = terminalLines[pane].filter((line) => frame >= line.at);
  return visible.slice(Math.max(0, visible.length - 7));
}

function lineColor(tone: Tone | undefined) {
  if (tone === "cmd") return "#f0f6fc";
  if (tone === "ok") return "#3fb950";
  if (tone === "warn") return "#f2cc60";
  if (tone === "json") return "#d2a8ff";
  if (tone === "info") return "#58a6ff";
  return "#8b949e";
}

function currentCaption(frame: number) {
  return captions.find((caption) => frame >= caption.from && frame < caption.to)?.text;
}

function Pane({ pane, frame }: { pane: PaneKey; frame: number }) {
  const meta = paneMeta[pane];
  const stage = activeStage(frame);
  const isFocused = stage.focus === pane || stage.focus === "all";
  const pulse = spring({
    frame: frame - stage.frame,
    fps: 30,
    config: { damping: 18, stiffness: 120 },
  });
  const borderOpacity = isFocused ? 0.78 + pulse * 0.22 : 0.34;
  const latestLine = terminalLines[pane].filter((line) => frame >= line.at).at(-1);

  return (
    <div
      style={{
        ...styles.pane,
        borderColor: `color-mix(in srgb, ${meta.accent} ${Math.round(borderOpacity * 100)}%, #30363d)`,
        boxShadow: isFocused ? `0 0 0 1px ${meta.accent}55, 0 18px 34px rgba(0,0,0,0.28)` : styles.pane.boxShadow,
      }}
    >
      <div style={styles.paneHeader}>
        <span style={{ ...styles.statusDot, background: meta.accent }} />
        <div style={styles.paneTitles}>
          <div style={styles.paneTitle}>{meta.title}</div>
          <div style={styles.paneSubtitle}>{meta.subtitle}</div>
        </div>
        <div style={styles.liveBadge}>{isFocused ? "active" : "ready"}</div>
      </div>
      <div style={styles.paneBody}>
        {linesForPane(pane, frame).map((line, index) => {
          const isLatest = latestLine === line;
          return (
            <div
              key={`${pane}-${line.at}-${index}`}
              style={{
                ...styles.terminalLine,
                color: lineColor(line.tone),
                opacity: isLatest ? 1 : 0.78,
              }}
            >
              {line.text}
            </div>
          );
        })}
        {linesForPane(pane, frame).length === 0 ? (
          <div style={{ ...styles.terminalLine, color: "#8b949e" }}>waiting for demo step...</div>
        ) : null}
      </div>
    </div>
  );
}

function Architecture({ frame }: { frame: number }) {
  const stage = activeStage(frame);
  const pulse = spring({
    frame: frame - stage.frame,
    fps: 30,
    config: { damping: 18, stiffness: 110 },
  });
  const packetOpacity = stage.index >= 4 && stage.index <= 9 ? 1 : 0;
  const packetProgress = interpolate(frame, [sec(50), sec(70), sec(80), sec(108), sec(121)], [0, 0.38, 0.72, 0.86, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const packetX = 96 + packetProgress * 865;

  return (
    <div style={styles.architecture}>
      <div style={styles.stageCopy}>
        <div style={styles.stageKicker}>Step {stage.index + 1} / {stages.length}</div>
        <div style={styles.stageTitle}>{stage.title}</div>
        <div style={styles.stageDetail}>{stage.detail}</div>
      </div>
      <svg width="100%" height="116" viewBox="0 0 1000 116" style={styles.archSvg}>
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill="#8b949e" />
          </marker>
        </defs>
        <line x1="170" y1="58" x2="350" y2="58" stroke="#8b949e" strokeWidth="3" markerEnd="url(#arrowhead)" />
        <line x1="490" y1="58" x2="680" y2="58" stroke="#8b949e" strokeWidth="3" markerEnd="url(#arrowhead)" />
        <line x1="680" y1="78" x2="500" y2="78" stroke="#8b949e" strokeWidth="3" markerEnd="url(#arrowhead)" />
        <line x1="350" y1="78" x2="170" y2="78" stroke="#8b949e" strokeWidth="3" markerEnd="url(#arrowhead)" />
        {[
          { key: "openclaw", label: "OpenClaw", x: 80, color: paneMeta.openclaw.accent },
          { key: "gateway", label: "OpenShell", x: 420, color: paneMeta.gateway.accent },
          { key: "redis", label: "Redis", x: 760, color: paneMeta.redis.accent },
          { key: "hermes", label: "Hermes", x: 920, color: paneMeta.hermes.accent },
        ].map((node) => {
          const isActive = stage.focus === node.key || stage.focus === "all" || (stage.focus === "bus" && node.key !== "hermes");
          const scale = isActive ? 1 + pulse * 0.06 : 1;
          return (
            <g key={node.key} transform={`translate(${node.x}, 58) scale(${scale})`}>
              <rect x="-68" y="-25" width="136" height="50" rx="8" fill="#161b22" stroke={node.color} strokeWidth={isActive ? 3 : 1.5} />
              <text x="0" y="6" textAnchor="middle" fill="#f0f6fc" fontSize="15" fontFamily="ui-monospace, Menlo, monospace">
                {node.label}
              </text>
            </g>
          );
        })}
        <g opacity={packetOpacity} transform={`translate(${packetX}, 58)`}>
          <rect x="-42" y="-14" width="84" height="28" rx="7" fill="#f2cc60" />
          <text x="0" y="5" textAnchor="middle" fill="#0d1117" fontSize="13" fontWeight="800" fontFamily="ui-monospace, Menlo, monospace">
            event
          </text>
        </g>
      </svg>
    </div>
  );
}

function EventSummary({ frame }: { frame: number }) {
  const showFinding = frame >= sec(50) && frame < sec(104);
  const showPlan = frame >= sec(104) && frame < sec(127);
  const showValue = frame >= sec(127);

  if (showValue) {
    return (
      <div style={{ ...styles.eventStrip, opacity: 1 }}>
        <div style={styles.eventLabel}>Why this matters</div>
        <div style={styles.valueGrid}>
          {valueProps.map((value) => (
            <div key={value} style={styles.valueItem}>{value}</div>
          ))}
        </div>
      </div>
    );
  }

  if (!showFinding && !showPlan) {
    return (
      <div style={styles.eventStrip}>
        <div style={styles.eventLabel}>Scenario</div>
        <div style={styles.eventType}>OpenClaw to Hermes</div>
        <div style={styles.eventSubject}>scope: workspace:nemoclaw-demo</div>
        <div style={styles.eventBody}>
          A release blocker moves through OpenShell shared memory, then Hermes sends a remediation plan back.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.eventStrip}>
      <div style={styles.eventLabel}>{showPlan ? "Hermes response" : "Shared memory event"}</div>
      <div style={styles.eventType}>{showPlan ? "release.remediation.planned" : "release.blocker.detected"}</div>
      <div style={styles.eventSubject}>
        {showPlan ? "subject: hermes:demo" : "subject: shared-memory-mvp/hermes-adapter-smoke"}
      </div>
      <div style={styles.eventBody}>
        {showPlan
          ? "state=ready_for_validation; next_steps=run smoke path, preserve driver boundary, publish result"
          : "The Hermes adapter smoke path must pass before the shared-memory MVP demo is marked ready."}
      </div>
    </div>
  );
}

export const SharedMemoryDemo = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const caption = currentCaption(frame);

  return (
    <AbsoluteFill style={styles.root}>
      <Audio src={staticFile("narration.mp3")} volume={1} playbackRate={AUDIO_PLAYBACK_RATE} />
      {stages.slice(1).map((stage) => (
        <Sequence key={stage.title} from={stage.frame} durationInFrames={18}>
          <Audio src={staticFile("milestone-chime.wav")} volume={0.07} />
        </Sequence>
      ))}
      <div style={{ ...styles.content, opacity: fadeIn }}>
        <div style={styles.header}>
          <div>
            <div style={styles.eyebrow}>OpenShell Shared Agent Memory</div>
            <div style={styles.title}>OpenClaw and Hermes coordinate through a Redis-backed OpenShell memory driver.</div>
          </div>
          <div style={styles.badge}>NemoClaw reference integration demo</div>
        </div>
        <Architecture frame={frame} />
        <EventSummary frame={frame} />
        <div style={styles.grid}>
          <Pane pane="redis" frame={frame} />
          <Pane pane="gateway" frame={frame} />
          <Pane pane="openclaw" frame={frame} />
          <Pane pane="hermes" frame={frame} />
        </div>
        <div style={styles.footer}>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${progress * 100}%` }} />
          </div>
          <div style={styles.caption}>{caption}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    background: "#0d1117",
    color: "#f0f6fc",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
  content: {
    height: "100%",
    boxSizing: "border-box",
    padding: "22px 26px 18px",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 20,
    alignItems: "flex-start",
    height: 82,
  },
  eyebrow: {
    color: "#3fb950",
    fontSize: 17,
    fontWeight: 800,
    letterSpacing: 0,
    marginBottom: 5,
  },
  title: {
    fontSize: 25,
    lineHeight: 1.08,
    fontWeight: 780,
    maxWidth: 820,
  },
  badge: {
    border: "1px solid #30363d",
    color: "#c9d1d9",
    borderRadius: 8,
    padding: "10px 12px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    whiteSpace: "nowrap",
    background: "#161b22",
  },
  architecture: {
    height: 124,
    display: "grid",
    gridTemplateColumns: "370px 1fr",
    gap: 18,
    alignItems: "center",
    border: "1px solid #30363d",
    borderRadius: 8,
    background: "#111820",
    padding: "12px 18px",
    boxSizing: "border-box",
  },
  stageCopy: {
    minWidth: 0,
  },
  stageKicker: {
    color: "#8b949e",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    marginBottom: 4,
  },
  stageTitle: {
    fontSize: 23,
    lineHeight: 1.08,
    fontWeight: 800,
  },
  stageDetail: {
    color: "#c9d1d9",
    fontSize: 14,
    lineHeight: 1.25,
    marginTop: 5,
  },
  archSvg: {
    display: "block",
  },
  eventStrip: {
    height: 62,
    marginTop: 10,
    border: "1px solid #30363d",
    borderRadius: 8,
    background: "#161b22",
    display: "grid",
    gridTemplateColumns: "150px 190px 310px 1fr",
    alignItems: "center",
    gap: 10,
    padding: "0 14px",
    boxSizing: "border-box",
  },
  eventLabel: {
    color: "#8b949e",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    textTransform: "uppercase",
  },
  eventType: {
    color: "#f2cc60",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 14,
    fontWeight: 800,
  },
  eventSubject: {
    color: "#d2a8ff",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
  },
  eventBody: {
    color: "#c9d1d9",
    fontSize: 13,
    lineHeight: 1.25,
  },
  valueGrid: {
    gridColumn: "2 / span 3",
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 10,
  },
  valueItem: {
    color: "#f0f6fc",
    fontSize: 12,
    lineHeight: 1.2,
    padding: "8px 10px",
    borderRadius: 6,
    background: "#0d1117",
    border: "1px solid #30363d",
  },
  grid: {
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gridTemplateRows: "1fr 1fr",
    gap: 10,
    height: 364,
  },
  pane: {
    border: "1.5px solid #30363d",
    borderRadius: 8,
    background: "#161b22",
    overflow: "hidden",
    boxShadow: "0 14px 28px rgba(0,0,0,0.22)",
  },
  paneHeader: {
    height: 37,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 13px",
    borderBottom: "1px solid #30363d",
    background: "#0d1117",
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 99,
  },
  paneTitles: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    gap: 10,
    alignItems: "baseline",
  },
  paneTitle: {
    fontSize: 14,
    fontWeight: 800,
  },
  paneSubtitle: {
    color: "#8b949e",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 11,
  },
  liveBadge: {
    color: "#8b949e",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 11,
  },
  paneBody: {
    padding: "10px 13px 12px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    lineHeight: "17px",
    boxSizing: "border-box",
  },
  terminalLine: {
    height: 17,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  footer: {
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "270px 1fr",
    gap: 18,
    alignItems: "center",
  },
  progressTrack: {
    height: 8,
    borderRadius: 99,
    background: "#30363d",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #3fb950, #58a6ff, #d2a8ff)",
  },
  caption: {
    color: "#c9d1d9",
    fontSize: 15,
    lineHeight: 1.24,
    textAlign: "right",
  },
};
