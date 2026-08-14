// Pack the extension into dist/agent-webbridge-cli-extension-v<version>.zip
// for Load unpacked distribution / Chrome Web Store submission.
// Uses the system `zip` (present on macOS and Linux; Windows ships tar).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const EXT = path.join(ROOT, "extension");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(DIST, `agent-webbridge-cli-extension-v${PKG.version}.zip`);

fs.mkdirSync(DIST, { recursive: true });
fs.rmSync(OUT, { force: true });
execFileSync("zip", ["-r", OUT, "."], { cwd: EXT, stdio: "inherit" });
console.log(`packed ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
