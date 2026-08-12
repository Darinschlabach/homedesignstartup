/**
 * Ensure a Chromium-compatible browser is available for render_preview.
 * Prefer system Chrome/Edge when present; otherwise install Playwright Chromium.
 *
 * Does not fail the package install hard — runtime still reports BROWSER_UNAVAILABLE
 * clearly if nothing can be launched.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function hasSystemBrowser() {
  const candidates = [
    process.env.ATELIER_CHROMIUM_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.some((c) => exists(c));
}

function main() {
  if (hasSystemBrowser()) {
    console.log(
      "[atelier-preview] System Chrome/Edge (or ATELIER_CHROMIUM_EXECUTABLE) detected — Playwright bundled Chromium install skipped.",
    );
    return;
  }

  try {
    const playwrightCli = require.resolve("playwright/cli.js");
    console.log(
      "[atelier-preview] No system browser detected — installing Playwright Chromium…",
    );
    const result = spawnSync(
      process.execPath,
      [playwrightCli, "install", "chromium"],
      {
        stdio: "inherit",
        env: process.env,
        cwd: path.resolve(__dirname, ".."),
      },
    );
    if (result.status !== 0) {
      console.warn(
        "[atelier-preview] playwright install chromium exited non-zero. render_preview will report BROWSER_UNAVAILABLE until a browser is provisioned.",
      );
    }
  } catch (error) {
    console.warn(
      "[atelier-preview] Could not run playwright install:",
      error instanceof Error ? error.message : error,
    );
  }
}

main();
