// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Converts ShellCheck json1 output into the SARIF subset accepted by CodeQL upload. */

export type ShellCheckComment = {
  file: string;
  line: number;
  endLine?: number;
  column: number;
  endColumn?: number;
  level: string;
  code: number;
  message: string;
};

export type ShellCheckJson = {
  comments?: ShellCheckComment[];
};

type SarifLevel = "error" | "warning" | "note";

type Sarif = {
  version: "2.1.0";
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        rules: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
        }>;
      };
    };
    results: Array<{
      ruleId: string;
      level: SarifLevel;
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region: {
            startLine: number;
            startColumn: number;
            endLine?: number;
            endColumn?: number;
          };
        };
      }>;
    }>;
  }>;
};

function mapLevel(level: string): SarifLevel {
  if (level === "error") {
    return "error";
  }
  if (level === "warning") {
    return "warning";
  }
  return "note";
}

function ruleId(code: number): string {
  return `SC${code}`;
}

export function shellcheckJsonToSarif(shellcheck: ShellCheckJson): Sarif {
  const comments = shellcheck.comments ?? [];
  const rules = [...new Map(comments.map((comment) => [comment.code, comment])).values()]
    .sort((left, right) => left.code - right.code)
    .map((comment) => ({
      id: ruleId(comment.code),
      name: ruleId(comment.code),
      shortDescription: { text: comment.level },
    }));

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "ShellCheck",
            informationUri: "https://www.shellcheck.net/",
            rules,
          },
        },
        results: comments.map((comment) => ({
          ruleId: ruleId(comment.code),
          level: mapLevel(comment.level),
          message: { text: comment.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: comment.file },
                region: {
                  startLine: comment.line,
                  startColumn: comment.column,
                  ...(comment.endLine === undefined ? {} : { endLine: comment.endLine }),
                  ...(comment.endColumn === undefined ? {} : { endColumn: comment.endColumn }),
                },
              },
            },
          ],
        })),
      },
    ],
  };
}

export function emptySarif(): Sarif {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [],
  };
}
