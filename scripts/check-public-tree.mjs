import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = new URL("../", import.meta.url);
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "data",
  "workspace",
  "secrets",
  "certs",
  "backups",
  "logs",
  "coverage",
  ".upgrade-run",
]);
const ignoredExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"]);

const forbiddenFileNames = new Set([
  ".env",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
]);

const contentChecks = [
  [/(?:^|\s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m, "private key material"],
  [/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "API key-like token"],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/, "site-specific private IPv4 address"],
  [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "site-specific private IPv4 address"],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, "site-specific private IPv4 address"],
  [/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, "CGNAT or tailnet IPv4 address"],
  [/\b(?:PASSWORD|API_KEY|TOKEN|SECRET)\s*=\s*["']?(?!<|example|changeme|test|\$\{)[^\s"']{12,}/i, "credential-like assignment"],
];

async function walk(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) files.push(...(await walk(child)));
    else files.push(child);
  }
  return files;
}

const failures = [];
for (const fileUrl of await walk(root)) {
  const path = fileUrl.pathname.replace(/^\/[A-Za-z]:/, (value) => value.slice(1));
  const display = relative(process.cwd(), path).replaceAll("\\", "/");
  const name = display.split("/").at(-1);

  if (forbiddenFileNames.has(name)) {
    failures.push(`${display}: forbidden credential/config filename`);
    continue;
  }
  if (ignoredExtensions.has(extname(name).toLowerCase())) continue;

  let content;
  try {
    content = await readFile(fileUrl, "utf8");
  } catch {
    continue;
  }
  for (const [pattern, label] of contentChecks) {
    if (pattern.test(content)) failures.push(`${display}: ${label}`);
  }
}

if (failures.length) {
  console.error("Public-tree validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Public-tree validation passed.");
}
