import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  createCompatibilityReport,
  renderReportJson,
  renderReportText,
} from "../src/compatibility-report.mjs";

function usage() {
  console.error(
    "usage: node scripts/report-compatibility.mjs --input <evidence.json> [--format text|json] [--json-out <report.json>]",
  );
  console.error("env: DSH_REPORT_REDACTIONS optional JSON array of secret strings to redact from check details");
}

function parseArgs(argv) {
  const args = { format: "text" };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--input") args.input = value;
    else if (flag === "--format") args.format = value;
    else if (flag === "--json-out") args.jsonOut = value;
    else return null;
  }
  if (!args.input) return null;
  if (args.format !== "text" && args.format !== "json") return null;
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  usage();
  process.exit(2);
}

let redactions = [];
if (process.env.DSH_REPORT_REDACTIONS) {
  try {
    redactions = JSON.parse(process.env.DSH_REPORT_REDACTIONS);
  } catch {
    console.error("DSH_REPORT_REDACTIONS must be a JSON array of strings");
    process.exit(2);
  }
}

let report;
try {
  const evidence = JSON.parse(await readFile(args.input, "utf8"));
  report = createCompatibilityReport({ ...evidence, redactions });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const json = renderReportJson(report);
if (args.jsonOut) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(args.jsonOut, json + "\n", "utf8");
}
console.log(args.format === "json" ? json : renderReportText(report));
