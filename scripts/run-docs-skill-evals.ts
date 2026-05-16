// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local, opt-in harness for NemoClaw docs-to-skills evals.
 *
 * This script intentionally does not integrate with CI. It reads docs/eval.json,
 * creates isolated web_docs and local_skills run directories, and optionally
 * executes user-provided agent commands for each lane.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EVAL_FILE = "docs/eval.json";
const DEFAULT_OUT_DIR = "docs/eval-runs";

type TergetContext = {
  type: "skill" | "reference";
  path: string;
};

type DocsEvalCase = {
  id: string;
  group: string;
  situation: string;
  motivation: string;
  outcome: string;
  terget_context: TergetContext;
};

type DocsEvalFile = {
  skill_name: string;
  prompt_template: string;
  expected_output_template: string;
  assertion_templates: string[];
  evals: DocsEvalCase[];
};

type RunLane = "web_docs" | "local_skills";
const RUN_LANES: readonly RunLane[] = ["web_docs", "local_skills"];

type Options = {
  evalFile: string;
  outDir: string;
  iteration: string;
  ids: Set<string> | null;
  limit: number | null;
  agentCommand: string | null;
  webAgentCommand: string | null;
  skillsAgentCommand: string | null;
  gradeContext: boolean;
  scaffoldOnly: boolean;
};

type PreparedEval = {
  runId: string;
  evalCase: DocsEvalCase;
  prompt: string;
  expectedOutput: string;
  assertions: string[];
  skillPath: string;
  runDir: string;
};

type RunReport = {
  eval_id?: unknown;
  lane?: unknown;
  answer_file?: unknown;
  context_used?: unknown;
  target_context_loaded?: unknown;
  total_tokens?: unknown;
  duration_ms?: unknown;
  notes?: unknown;
};

type GradingFile = {
  assertion_results?: unknown;
  summary?: unknown;
};

type TimingFile = {
  duration_ms?: unknown;
  total_tokens?: unknown;
  tokens?: unknown;
};

type TargetContextGradingFile = {
  passed?: unknown;
};

type NumericSummary = {
  mean: number | null;
  stddev: number | null;
  count: number;
};

type LaneAggregate = {
  pass_rate: NumericSummary;
  time_seconds: NumericSummary;
  tokens: NumericSummary;
  raw_counts: {
    evals: number;
    graded: number;
    timed: number;
    token_recorded: number;
  };
  target_context_pass_rate?: NumericSummary;
};

function usage(): string {
  return [
    "Usage: npx tsx scripts/run-docs-skill-evals.ts [options]",
    "",
    "Options:",
    "  --eval-file <path>      Eval JSON file. Default: docs/eval.json",
    "  --out-dir <path>        Eval workspace directory. Default: docs/eval-runs",
    "  --iteration <name>      Iteration directory name. Default: iteration-<timestamp>",
    "  --id <id>               Eval id to include. May be repeated or comma-separated.",
    "  --limit <n>             Limit number of evals for a smoke run.",
    "  --agent-command <cmd>   Optional command template to execute both lanes.",
    "  --web-agent-command <cmd>",
    "                          Optional command template for the web_docs lane.",
    "  --skills-agent-command <cmd>",
    "                          Optional command template for the local_skills lane.",
    "                          Placeholders: {instructions}, {output_dir}, {run_dir},",
    "                          {eval_id}, {lane}, {prompt}",
    "  --grade-context         Grade local_skills transcripts for target context loading.",
    "                          Also refreshes benchmark.json with target-context pass rate.",
    "  --scaffold-only         Write run directories but do not execute agent command.",
    "  --help                  Show this help.",
    "",
    "Example scaffold:",
    "  npx tsx scripts/run-docs-skill-evals.ts --limit 3",
    "",
    "Example run with an external agent CLI:",
    "  npx tsx scripts/run-docs-skill-evals.ts --limit 3 \\",
    "    --agent-command 'my-agent --instructions {instructions} --out {output_dir}'",
    "",
    "Cursor/Codex subagent usage:",
    "  1. Run the scaffold command.",
    "  2. Send web_docs/instructions.md to an internet/public-docs agent.",
    "  3. Send local_skills/instructions.md to an offline/local-skills agent.",
    "  4. Save transcripts under each lane and rerun with --grade-context.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    evalFile: DEFAULT_EVAL_FILE,
    outDir: DEFAULT_OUT_DIR,
    iteration: `iteration-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ids: null,
    limit: null,
    agentCommand: null,
    webAgentCommand: null,
    skillsAgentCommand: null,
    gradeContext: false,
    scaffoldOnly: false,
  };

  const ids = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--eval-file") {
      options.evalFile = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--out-dir") {
      options.outDir = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--iteration") {
      options.iteration = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--id") {
      for (const id of requireValue(argv, (index += 1), arg).split(",")) {
        if (id.trim()) {
          ids.add(id.trim());
        }
      }
      continue;
    }
    if (arg === "--limit") {
      options.limit = parsePositiveInteger(requireValue(argv, (index += 1), arg), arg);
      continue;
    }
    if (arg === "--agent-command") {
      options.agentCommand = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--web-agent-command") {
      options.webAgentCommand = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--skills-agent-command") {
      options.skillsAgentCommand = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--grade-context") {
      options.gradeContext = true;
      continue;
    }
    if (arg === "--scaffold-only") {
      options.scaffoldOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  options.ids = ids.size > 0 ? ids : null;
  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function renderTemplate(template: string, evalCase: DocsEvalCase): string {
  return template
    .replaceAll("{{situation}}", evalCase.situation)
    .replaceAll("{{motivation}}", evalCase.motivation)
    .replaceAll("{{outcome}}", evalCase.outcome);
}

function absoluteRepoPath(relativePath: string): string {
  return path.resolve(REPO_ROOT, relativePath);
}

function skillPathForContext(context: TergetContext): string {
  if (context.type === "skill") {
    return context.path;
  }
  const marker = "/references/";
  const markerIndex = context.path.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Reference context path is not under references/: ${context.path}`);
  }
  return `${context.path.slice(0, markerIndex)}/SKILL.md`;
}

function validateEvalFile(evalFile: DocsEvalFile): void {
  const ids = new Set<string>();
  for (const evalCase of evalFile.evals) {
    if (ids.has(evalCase.id)) {
      throw new Error(`Duplicate eval id: ${evalCase.id}`);
    }
    ids.add(evalCase.id);

    const contextPath = absoluteRepoPath(evalCase.terget_context.path);
    if (!fs.existsSync(contextPath)) {
      throw new Error(
        `Missing terget_context path for ${evalCase.id}: ${evalCase.terget_context.path}`,
      );
    }

    const skillPath = absoluteRepoPath(skillPathForContext(evalCase.terget_context));
    if (!fs.existsSync(skillPath)) {
      throw new Error(
        `Missing skill path for ${evalCase.id}: ${path.relative(REPO_ROOT, skillPath)}`,
      );
    }
  }
}

function selectEvalCases(evalFile: DocsEvalFile, options: Options): DocsEvalCase[] {
  let evals = evalFile.evals;
  if (options.ids) {
    evals = evals.filter((evalCase) => options.ids?.has(evalCase.id));
    const found = new Set(evals.map((evalCase) => evalCase.id));
    const missing = [...options.ids].filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown eval id(s): ${missing.join(", ")}`);
    }
  }
  if (options.limit !== null) {
    evals = evals.slice(0, options.limit);
  }
  return evals;
}

function prepareEval(
  evalFile: DocsEvalFile,
  evalCase: DocsEvalCase,
  iterationDir: string,
  index: number,
): PreparedEval {
  const prompt = renderTemplate(evalFile.prompt_template, evalCase);
  const expectedOutput = renderTemplate(evalFile.expected_output_template, evalCase);
  const assertions = evalFile.assertion_templates.map((assertion) =>
    renderTemplate(assertion, evalCase),
  );
  const skillPath = skillPathForContext(evalCase.terget_context);
  const runId = String(index + 1).padStart(3, "0");
  return {
    runId,
    evalCase,
    prompt,
    expectedOutput,
    assertions,
    skillPath,
    runDir: path.join(iterationDir, runId),
  };
}

function writePreparedEval(prepared: PreparedEval): void {
  const webDocsDir = path.join(prepared.runDir, "web_docs");
  const localSkillsDir = path.join(prepared.runDir, "local_skills");
  fs.mkdirSync(path.join(webDocsDir, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(localSkillsDir, "outputs"), { recursive: true });

  fs.writeFileSync(
    path.join(prepared.runDir, "eval-case.json"),
    `${JSON.stringify(
      {
        run_id: prepared.runId,
        source_eval_id: prepared.evalCase.id,
        group: prepared.evalCase.group,
        prompt: prepared.prompt,
        expected_output: prepared.expectedOutput,
        assertions: prepared.assertions,
        terget_context: prepared.evalCase.terget_context,
        local_skills_entrypoint: prepared.skillPath,
      },
      null,
      2,
    )}\n`,
  );

  fs.writeFileSync(
    path.join(webDocsDir, "instructions.md"),
    buildInstructions(prepared, "web_docs"),
  );
  fs.writeFileSync(
    path.join(localSkillsDir, "instructions.md"),
    buildInstructions(prepared, "local_skills"),
  );
}

function buildInstructions(prepared: PreparedEval, lane: RunLane): string {
  const outputDir = path.relative(REPO_ROOT, path.join(prepared.runDir, lane, "outputs"));
  const lines = [
    `# Eval ${prepared.runId} (${lane})`,
    "",
    "Execute the task in a clean context. Save any produced files under:",
    "",
    `\`${outputDir}\``,
    "",
  ];

  if (lane === "local_skills") {
    lines.push(
      "You are the local-skills agent. Do not browse the internet or public docs website for this run.",
      "Use the downloaded generated NemoClaw user skills under `.agents/skills/`.",
      "Choose the skill and reference files that best match the task. Load additional references only when the skill guidance says they are needed.",
      "",
      "Do not inspect `eval-case.json`, `benchmark.json`, or other eval metadata. Answer only from the task instructions and the generated local skills.",
      "Record every skill or reference file you loaded in `outputs/run-report.json` so the evaluator can verify which context was triggered.",
      "",
    );
  } else {
    lines.push(
      "You are the web-docs agent. Use internet access and the public NemoClaw documentation website or public search results.",
      "Do not read local `.agents/skills/` files, local generated skill references, or local `docs/` source files from this checkout.",
      "Answer from public documentation evidence as a baseline for comparison against the local-skills lane.",
      "",
    );
  }

  lines.push(
    "## Task",
    "",
    prepared.prompt,
    "",
    "## Expected Output",
    "",
    prepared.expectedOutput,
    "",
    "## Assertions",
    "",
    ...prepared.assertions.map((assertion) => `- ${assertion}`),
    "",
  );

  lines.push(...buildOutputContract(prepared, lane));

  return `${lines.join("\n")}\n`;
}

function buildOutputContract(prepared: PreparedEval, lane: RunLane): string[] {
  const contextDescription =
    lane === "local_skills"
      ? "local skill/reference file paths loaded during the run"
      : "public documentation URLs or search result URLs used during the run";

  return [
    "## Output Contract",
    "",
    "Write the following files under the `outputs/` directory:",
    "",
    "1. `answer.md` — the final user-facing answer for the task.",
    "2. `run-report.json` — structured metadata for grading.",
    "",
    "After a grader evaluates the answer, write `grading.json` in the lane directory using the assertion-results shape from the eval guidelines.",
    "The harness reads `grading.json`, `timing.json`, and `outputs/run-report.json` when it writes `benchmark.json`.",
    "",
    "`run-report.json` must use this shape:",
    "",
    "```json",
    JSON.stringify(
      {
        eval_id: prepared.runId,
        lane,
        answer_file: "answer.md",
        context_used: [contextDescription],
        target_context_loaded: null,
        total_tokens: null,
        duration_ms: null,
        notes: "Briefly describe what context you loaded and why.",
      },
      null,
      2,
    ),
    "```",
    "",
    "`target_context_loaded` is reserved for the evaluator. Leave it as null.",
    "Use `total_tokens` and `duration_ms` only if your agent runtime reports them; otherwise leave them as null.",
    "Keep `answer.md` concise and scoped to the user's task. Do not dump unrelated reference content.",
    "",
  ];
}

function runAgentCommand(commandTemplate: string, prepared: PreparedEval, lane: RunLane): void {
  const runDir = path.join(prepared.runDir, lane);
  const outputDir = path.join(runDir, "outputs");
  const instructionsPath = path.join(runDir, "instructions.md");
  const startedAt = Date.now();
  const command = renderCommand(commandTemplate, {
    instructions: instructionsPath,
    output_dir: outputDir,
    run_dir: runDir,
    eval_id: prepared.runId,
    lane,
    prompt: prepared.prompt,
  });

  const result = spawnSync(command, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: true,
  });
  const durationMs = Date.now() - startedAt;
  const transcript = [
    `$ ${command}`,
    "",
    "## stdout",
    "",
    result.stdout || "",
    "",
    "## stderr",
    "",
    result.stderr || "",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(runDir, "transcript.txt"), transcript);
  fs.writeFileSync(
    path.join(runDir, "timing.json"),
    `${JSON.stringify(
      {
        duration_ms: durationMs,
        exit_code: result.status,
        signal: result.signal,
      },
      null,
      2,
    )}\n`,
  );

  if (result.status !== 0) {
    throw new Error(`Agent command failed for eval ${prepared.runId} ${lane}`);
  }
}

function renderCommand(commandTemplate: string, replacements: Record<string, string>): string {
  let command = commandTemplate;
  for (const [key, value] of Object.entries(replacements)) {
    command = command.replaceAll(`{${key}}`, shellQuote(value));
  }
  return command;
}

function shellQuote(value: string): string {
  if (value === "") {
    return "''";
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function gradeTargetContext(prepared: PreparedEval): void {
  const localSkillsDir = path.join(prepared.runDir, "local_skills");
  const targetPath = prepared.evalCase.terget_context.path;
  const evidence = findTargetContextEvidence(localSkillsDir, targetPath);
  const passed = evidence.length > 0;
  fs.writeFileSync(
    path.join(localSkillsDir, "target-context-grading.json"),
    `${JSON.stringify(
      {
        assertion: "The local_skills run loaded or triggered the expected terget_context.",
        terget_context: prepared.evalCase.terget_context,
        passed,
        evidence: passed
          ? evidence
          : [
              "No transcript evidence found. Save agent logs or tool transcripts in the local_skills run directory, then rerun with --grade-context.",
            ],
      },
      null,
      2,
    )}\n`,
  );
}

function findTargetContextEvidence(runDir: string, targetPath: string): string[] {
  const transcriptFiles = listTranscriptFiles(runDir);
  const normalizedTarget = normalizePathForSearch(targetPath);
  const basename = path.basename(targetPath);
  const evidence: string[] = [];

  evidence.push(...findRunReportEvidence(runDir, normalizedTarget, basename));

  for (const transcriptFile of transcriptFiles) {
    const raw = fs.readFileSync(transcriptFile, "utf8");
    const normalizedRaw = normalizePathForSearch(raw);
    if (normalizedRaw.includes(normalizedTarget) || normalizedRaw.includes(basename)) {
      evidence.push(`Matched ${path.relative(REPO_ROOT, transcriptFile)}`);
    }
  }

  return evidence;
}

function findRunReportEvidence(
  runDir: string,
  normalizedTarget: string,
  basename: string,
): string[] {
  const reportPath = path.join(runDir, "outputs", "run-report.json");
  if (!fs.existsSync(reportPath)) {
    return [];
  }

  const report = readJson<RunReport>(reportPath);
  const evidence: string[] = [];
  const contextUsed = Array.isArray(report.context_used)
    ? report.context_used.filter((entry): entry is string => typeof entry === "string")
    : [];
  const normalizedContext = contextUsed.map(normalizePathForSearch);

  if (
    normalizedContext.some((entry) => entry.includes(normalizedTarget) || entry.includes(basename))
  ) {
    evidence.push(`run-report.json context_used includes ${basename}`);
  }
  if (report.target_context_loaded === true) {
    evidence.push("run-report.json target_context_loaded is true");
  }

  return evidence;
}

function listTranscriptFiles(root: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(root)) {
    return files;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "outputs") {
        continue;
      }
      files.push(...listTranscriptFiles(fullPath));
      continue;
    }
    if (
      entry.isFile() &&
      ["transcript.txt", ".jsonl", ".log"].some((suffix) => entry.name.endsWith(suffix))
    ) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function normalizePathForSearch(value: string): string {
  return value.replaceAll("\\", "/");
}

function writeBenchmark(iterationDir: string, preparedEvals: PreparedEval[]): void {
  const webDocs = aggregateLane(preparedEvals, "web_docs");
  const localSkills = aggregateLane(preparedEvals, "local_skills");
  const delta = {
    pass_rate: subtractNullable(localSkills.pass_rate.mean, webDocs.pass_rate.mean),
    time_seconds: subtractNullable(localSkills.time_seconds.mean, webDocs.time_seconds.mean),
    tokens: subtractNullable(localSkills.tokens.mean, webDocs.tokens.mean),
    target_context_pass_rate: localSkills.target_context_pass_rate?.mean ?? null,
  };

  fs.writeFileSync(
    path.join(iterationDir, "benchmark.json"),
    `${JSON.stringify(
      {
        eval_count: preparedEvals.length,
        lanes: RUN_LANES,
        run_summary: {
          web_docs: webDocs,
          local_skills: localSkills,
          delta,
        },
        notes: [
          "delta is local_skills - web_docs.",
          "pass_rate values come from each lane's grading.json.",
          "time_seconds and tokens come from timing.json first, then outputs/run-report.json.",
          "target_context_pass_rate is only computed for local_skills after --grade-context writes target-context-grading.json.",
        ],
        eval_ids: preparedEvals.map((prepared) => ({
          run_id: prepared.runId,
          source_eval_id: prepared.evalCase.id,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

function aggregateLane(preparedEvals: PreparedEval[], lane: RunLane): LaneAggregate {
  const passRates: number[] = [];
  const timeSeconds: number[] = [];
  const tokens: number[] = [];
  const targetContextRates: number[] = [];

  for (const prepared of preparedEvals) {
    const laneDir = path.join(prepared.runDir, lane);
    pushIfNumber(passRates, readPassRate(path.join(laneDir, "grading.json")));
    pushIfNumber(timeSeconds, readDurationSeconds(laneDir));
    pushIfNumber(tokens, readTokenCount(laneDir));
    if (lane === "local_skills") {
      pushIfNumber(
        targetContextRates,
        readTargetContextPassRate(path.join(laneDir, "target-context-grading.json")),
      );
    }
  }

  const aggregate: LaneAggregate = {
    pass_rate: summarize(passRates),
    time_seconds: summarize(timeSeconds),
    tokens: summarize(tokens),
    raw_counts: {
      evals: preparedEvals.length,
      graded: passRates.length,
      timed: timeSeconds.length,
      token_recorded: tokens.length,
    },
  };

  if (lane === "local_skills") {
    aggregate.target_context_pass_rate = summarize(targetContextRates);
  }

  return aggregate;
}

function readPassRate(filePath: string): number | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const grading = readJson<GradingFile>(filePath);
  const summary = asRecord(grading.summary);
  const summaryPassRate = numberFromUnknown(summary?.pass_rate);
  if (summaryPassRate !== null) {
    return summaryPassRate;
  }

  if (!Array.isArray(grading.assertion_results) || grading.assertion_results.length === 0) {
    return null;
  }

  const assertions = grading.assertion_results
    .map(asRecord)
    .filter((assertion): assertion is Record<string, unknown> => assertion !== null);
  if (assertions.length === 0) {
    return null;
  }

  const passed = assertions.filter((assertion) => assertion.passed === true).length;
  return passed / assertions.length;
}

function readDurationSeconds(laneDir: string): number | null {
  const timing = readOptionalJson<TimingFile>(path.join(laneDir, "timing.json"));
  const report = readOptionalJson<RunReport>(path.join(laneDir, "outputs", "run-report.json"));
  const durationMs =
    numberFromUnknown(timing?.duration_ms) ?? numberFromUnknown(report?.duration_ms);
  return durationMs === null ? null : durationMs / 1000;
}

function readTokenCount(laneDir: string): number | null {
  const timing = readOptionalJson<TimingFile>(path.join(laneDir, "timing.json"));
  const report = readOptionalJson<RunReport>(path.join(laneDir, "outputs", "run-report.json"));
  return (
    numberFromUnknown(timing?.total_tokens) ??
    numberFromUnknown(timing?.tokens) ??
    numberFromUnknown(report?.total_tokens)
  );
}

function readTargetContextPassRate(filePath: string): number | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const grading = readJson<TargetContextGradingFile>(filePath);
  if (grading.passed === true) {
    return 1;
  }
  if (grading.passed === false) {
    return 0;
  }
  return null;
}

function readOptionalJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson<T>(filePath);
}

function pushIfNumber(values: number[], value: number | null): void {
  if (value !== null && Number.isFinite(value)) {
    values.push(value);
  }
}

function summarize(values: number[]): NumericSummary {
  if (values.length === 0) {
    return { mean: null, stddev: null, count: 0 };
  }
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return {
    mean: roundMetric(mean),
    stddev: roundMetric(Math.sqrt(variance)),
    count: values.length,
  };
}

function subtractNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return roundMetric(left - right);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const evalPath = absoluteRepoPath(options.evalFile);
  const evalFile = readJson<DocsEvalFile>(evalPath);
  validateEvalFile(evalFile);

  const selectedEvalCases = selectEvalCases(evalFile, options);
  const iterationDir = absoluteRepoPath(path.join(options.outDir, options.iteration));
  fs.mkdirSync(iterationDir, { recursive: true });

  const preparedEvals = selectedEvalCases.map((evalCase, index) =>
    prepareEval(evalFile, evalCase, iterationDir, index),
  );

  for (const prepared of preparedEvals) {
    writePreparedEval(prepared);
    if (!options.scaffoldOnly) {
      const webCommand = options.webAgentCommand ?? options.agentCommand;
      const skillsCommand = options.skillsAgentCommand ?? options.agentCommand;
      if (webCommand) {
        runAgentCommand(webCommand, prepared, "web_docs");
      }
      if (skillsCommand) {
        runAgentCommand(skillsCommand, prepared, "local_skills");
      }
    }
    if (options.gradeContext) {
      gradeTargetContext(prepared);
    }
  }

  writeBenchmark(iterationDir, preparedEvals);
  console.log(
    `Prepared ${preparedEvals.length} eval(s) in ${path.relative(REPO_ROOT, iterationDir)}`,
  );
}

main();
