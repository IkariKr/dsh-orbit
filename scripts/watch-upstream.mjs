import { writeFile } from "node:fs/promises";
import process from "node:process";
import { compatibilityProfiles } from "../src/compatibility.mjs";

const registryUrl =
  process.env.DSH_WATCH_REGISTRY_URL ?? "https://registry.npmjs.org/@deepseek-ai/dsh/latest";
const jsonOutIndex = process.argv.indexOf("--json-out");
const jsonOut = jsonOutIndex >= 0 ? process.argv[jsonOutIndex + 1] : undefined;

async function latestVersion() {
  const response = await fetch(registryUrl);
  if (!response.ok) {
    throw new Error(`registry returned HTTP ${response.status}`);
  }
  const manifest = await response.json();
  if (typeof manifest?.version !== "string") {
    throw new Error("registry manifest has no version field");
  }
  return manifest.version;
}

try {
  const version = await latestVersion();
  const knownProfiles = Object.keys(compatibilityProfiles);
  const classification = compatibilityProfiles[version] ? "supported" : "unknown";
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    registry: registryUrl,
    latestVersion: version,
    classification,
    knownProfiles,
  };
  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(`upstream dsh: ${version} (${classification})`);
  if (classification === "unknown") {
    console.log(`known compatibility profiles: ${knownProfiles.join(", ") || "none"}`);
    console.log(
      "::warning title=Unknown upstream DSH release::A newly published DSH version is absent from the compatibility registry. Review it before any support claim; see docs/compatibility.md.",
    );
    console.log("review required before any support claim; see docs/compatibility.md");
  } else {
    console.log("no action required");
  }
} catch (error) {
  console.error(`upstream dsh watch failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
