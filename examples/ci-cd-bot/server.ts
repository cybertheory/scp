/**
 * CI-CD Bot - SWP example (TypeScript SDK).
 * States: INITIAL -> LINT -> RUN_LINT -> REVIEW_RESULTS -> MERGE_OK | REQUEST_CHANGES
 *
 * Uses SDK createApp with tool hooks (run_lint_check) and resources (lint_help, lint_report).
 *
 * Run from repo root: npx tsx examples/ci-cd-bot/server.ts (imports from ../../sdks/typescript/src/...).
 * With the package installed: npm install swp-sdk && import from "swp-sdk" (see docs/quickstart.md).
 */
import { execSync } from "child_process";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, normalize } from "path";
import { serve } from "@hono/node-server";
import { createApp, SWPWorkflow } from "../../sdks/typescript/src/server.js";
import type { RunRecord } from "../../sdks/typescript/src/server.js";
import type { TransitionDef } from "../../sdks/typescript/src/models.js";

const transitions: TransitionDef[] = [
  { from_state: "INITIAL", action: "start", to_state: "LINT", is_critical: false },
  { from_state: "LINT", action: "run_lint", to_state: "RUN_LINT", is_critical: false },
  {
    from_state: "RUN_LINT",
    action: "lint_done",
    to_state: "REVIEW_RESULTS",
    expects: { passed: "boolean", issues: "number" },
    is_critical: false,
  },
  { from_state: "REVIEW_RESULTS", action: "merge_ok", to_state: "MERGE_OK", is_critical: false },
  {
    from_state: "REVIEW_RESULTS",
    action: "request_changes",
    to_state: "REQUEST_CHANGES",
    expects: { reason: "string" },
    is_critical: false,
  },
];

const BASE = "http://localhost:3000";
const workflow = new SWPWorkflow("ci-cd-bot-v1", "INITIAL", transitions, BASE)
  .hint("INITIAL", "Start the CI-CD workflow. Use the 'start' action.")
  .hint(
    "LINT",
    "Run the linter: use the 'run_lint_check' tool (optional: dir) to execute the linter and get results, then use 'run_lint' to proceed. Or use 'run_lint' directly and call 'lint_done' later with passed/issues. Read the lint_help resource for instructions."
  )
  .hint(
    "RUN_LINT",
    "Lint is running. Wait for stream or poll, then call 'lint_done' with passed (boolean) and issues (number). Use the lint_report resource after moving to REVIEW_RESULTS."
  )
  .hint(
    "REVIEW_RESULTS",
    "Review results. Use the 'lint_report' resource to read the full report. Use 'merge_ok' to approve or 'request_changes' with reason."
  )
  .hint("MERGE_OK", "Merge approved.")
  .hint("REQUEST_CHANGES", "Changes requested.")
  .skill("LINT", "lint-review-skill", "lint-review-skill/SKILL.md")
  .statusDefault("RUN_LINT", "processing");

// --- Tool: run_lint_check (LINT state) - runs real lint and stores result in run data
workflow.tool(
  "LINT",
  "run_lint_check",
  (run_id: string, run_record: RunRecord, body: Record<string, unknown>) => {
    const dir = (body?.dir as string) || process.cwd();
    const resolved = join(process.cwd(), dir);
    if (!existsSync(resolved)) {
      run_record.data = {
        ...run_record.data,
        lint_result: {
          passed: false,
          issues: 1,
          log: `Directory not found: ${dir}`,
        },
      };
      return { passed: false, issues: 1, log: `Directory not found: ${dir}` };
    }
    try {
      const out = execSync("npx eslint . --format compact 2>&1 || true", {
        cwd: resolved,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      const lines = out.trim().split("\n").filter(Boolean);
      const issueLine = lines.find((l) => l.includes("problem") || l.includes("error"));
      const issues = issueLine
        ? parseInt(issueLine.replace(/\D/g, ""), 10) || lines.length
        : lines.length;
      const passed = issues === 0;
      const result = { passed, issues: issues || (lines.length ? 1 : 0), log: out.slice(-2000) };
      run_record.data = { ...run_record.data, lint_result: result };
      return result;
    } catch {
      // Fallback: simple "lint" that counts .ts/.js files (no ESLint required)
      const walk = (p: string): number => {
        let count = 0;
        try {
          for (const e of readdirSync(p, { withFileTypes: true })) {
            const full = join(p, e.name);
            if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) count += walk(full);
            else if (e.isFile() && /\.(ts|js)$/i.test(e.name)) count += 1;
          }
        } catch {}
        return count;
      };
      const fileCount = walk(resolved);
      const result = { passed: true, issues: 0, log: `Checked ${fileCount} file(s); no ESLint (using fallback).` };
      run_record.data = { ...run_record.data, lint_result: result };
      return result;
    }
  },
  {
    description: "Run ESLint in the given directory (default: current). Returns { passed, issues, log } and stores result for the run.",
    expects: { dir: "string (optional)" },
  }
);

// --- Resource: lint_help (LINT state)
workflow.resource(
  "LINT",
  "lint_help",
  () =>
    `# Lint stage instructions

1. Use the **run_lint_check** tool to execute the linter (optional body: \`{ "dir": "." }\`).
2. The tool returns \`{ passed, issues, log }\` and stores the result in the run.
3. Use the **run_lint** transition to move to RUN_LINT.
4. After the run is in REVIEW_RESULTS, use the **lint_report** resource to read the full report.
`,
  { name: "Lint instructions", mime_type: "text/markdown" }
);

// --- Resource: lint_report (REVIEW_RESULTS state)
workflow.resource(
  "REVIEW_RESULTS",
  "lint_report",
  (_run_id: string, run_record: RunRecord) => {
    const lint = run_record.data?.lint_result as { passed?: boolean; issues?: number; log?: string } | undefined;
    const d = run_record.data as Record<string, unknown>;
    if (!lint && d?.passed !== undefined) {
      return `# Lint report\n\nPassed: ${d.passed}\nIssues: ${d.issues ?? "N/A"}\n`;
    }
    if (!lint) {
      return "# Lint report\n\nNo lint result yet. Run the linter in the LINT state and complete the flow.\n";
    }
    return `# Lint report

- **Passed:** ${lint.passed}
- **Issues:** ${lint.issues ?? "N/A"}

## Log (excerpt)

\`\`\`
${(lint.log ?? "").slice(-1500)}
\`\`\`
`;
  },
  { name: "Lint report", mime_type: "text/markdown" }
);

const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
const app = createApp(workflow, store);

// Serve skills from repo skills dir (path traversal safe)
const SKILLS_DIR = resolve(process.cwd(), "skills");
app.get("/skills/*", async (c) => {
  const raw = c.req.path.replace(/^\/skills\//, "").replace(/^\/+/, "");
  const requested = normalize(raw).split("/").filter(Boolean).join("/");
  const full = resolve(SKILLS_DIR, requested);
  if (!full.startsWith(SKILLS_DIR)) {
    return c.json({ hint: "Invalid path" }, 403);
  }
  try {
    const content = readFileSync(full, "utf-8");
    return c.text(content, 200, { "Content-Type": "text/markdown" });
  } catch {
    return c.json({ hint: "Not found" }, 404);
  }
});

const port = 3000;
console.log(`SWP CI-CD server at http://localhost:${port}`);
serve({ fetch: app.fetch, port });
export { app };
