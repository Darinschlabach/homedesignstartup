import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright";

export type PreviewRenderBackend =
  | "playwright-executable-env"
  | "playwright-system-chrome"
  | "playwright-system-edge"
  | "playwright-bundled-chromium";

export type PreviewBrowserLaunch = {
  backend: PreviewRenderBackend;
  launchOptions: LaunchOptions;
  executablePath?: string;
};

const WINDOWS_CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe",
  ),
];

const WINDOWS_EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  ),
];

const LINUX_CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const MAC_CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const MAC_EDGE_CANDIDATES = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function firstExisting(paths: string[]): string | undefined {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function commonLaunchArgs(): string[] {
  return [
    "--use-gl=angle",
    "--ignore-gpu-blocklist",
    "--disable-dev-shm-usage",
    "--no-sandbox",
  ];
}

/**
 * Resolve a Chromium-compatible browser for Three.js WebGL preview captures.
 *
 * Why this exists:
 * - Playwright's package does not ship browser binaries.
 * - Cursor often sets PLAYWRIGHT_BROWSERS_PATH to an empty sandbox cache,
 *   so chromium.executablePath() points at a missing file.
 * - Prefer an explicitly configured executable, then system Chrome/Edge,
 *   then a successfully installed Playwright Chromium build.
 */
export function resolvePreviewBrowserLaunch(): PreviewBrowserLaunch | null {
  const envPath =
    process.env.ATELIER_CHROMIUM_EXECUTABLE?.trim() ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() ||
    process.env.CHROMIUM_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) {
    return {
      backend: "playwright-executable-env",
      executablePath: envPath,
      launchOptions: {
        headless: true,
        executablePath: envPath,
        args: commonLaunchArgs(),
      },
    };
  }

  const systemChrome = firstExisting([
    ...WINDOWS_CHROME_CANDIDATES,
    ...LINUX_CHROME_CANDIDATES,
    ...MAC_CHROME_CANDIDATES,
  ]);
  if (systemChrome) {
    return {
      backend: "playwright-system-chrome",
      executablePath: systemChrome,
      launchOptions: {
        headless: true,
        executablePath: systemChrome,
        args: commonLaunchArgs(),
      },
    };
  }

  const systemEdge = firstExisting([
    ...WINDOWS_EDGE_CANDIDATES,
    ...MAC_EDGE_CANDIDATES,
  ]);
  if (systemEdge) {
    return {
      backend: "playwright-system-edge",
      executablePath: systemEdge,
      launchOptions: {
        headless: true,
        executablePath: systemEdge,
        args: commonLaunchArgs(),
      },
    };
  }

  // Bundled Playwright Chromium — only if the binary actually exists.
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) {
      return {
        backend: "playwright-bundled-chromium",
        executablePath: bundled,
        launchOptions: {
          headless: true,
          executablePath: bundled,
          args: commonLaunchArgs(),
        },
      };
    }
  } catch {
    // ignore — report as unavailable below
  }

  return null;
}

export function previewBrowserUnavailableError(): {
  code: "BROWSER_UNAVAILABLE";
  error: string;
  remediation: string[];
  env: {
    vercel: boolean;
    playwrightBrowsersPath: string | null;
  };
} {
  const onVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  return {
    code: "BROWSER_UNAVAILABLE",
    error: onVercel
      ? "Preview rendering requires a Chromium-compatible browser. Vercel serverless does not ship one by default."
      : "Preview rendering requires a Chromium-compatible browser, but none was found.",
    remediation: onVercel
      ? [
          "Run the Home Design Agent on a Node host with Chrome/Chromium installed, or",
          "Set ATELIER_CHROMIUM_EXECUTABLE to a Chromium binary available to the runtime, or",
          "Use a dedicated long-running preview/render service (workers/render is currently a stub).",
        ]
      : [
          "Install Google Chrome or Microsoft Edge, or",
          "Run: pnpm --filter @aihd/web exec playwright install chromium",
          "Or set ATELIER_CHROMIUM_EXECUTABLE to a Chromium binary path.",
          "If PLAYWRIGHT_BROWSERS_PATH points at an empty Cursor sandbox cache, install browsers there or unset it.",
        ],
    env: {
      vercel: onVercel,
      playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
    },
  };
}

let sharedBrowser: Browser | null = null;
let sharedBackend: PreviewRenderBackend | null = null;

export async function getPreviewBrowser(): Promise<{
  browser: Browser;
  backend: PreviewRenderBackend;
}> {
  if (sharedBrowser && sharedBrowser.isConnected() && sharedBackend) {
    return { browser: sharedBrowser, backend: sharedBackend };
  }

  const resolved = resolvePreviewBrowserLaunch();
  if (!resolved) {
    const detail = previewBrowserUnavailableError();
    throw Object.assign(new Error(detail.error), {
      code: detail.code,
      remediation: detail.remediation,
      env: detail.env,
    });
  }

  sharedBrowser = await chromium.launch(resolved.launchOptions);
  sharedBackend = resolved.backend;
  return { browser: sharedBrowser, backend: sharedBackend };
}

export function getPreviewBrowserDiagnostics() {
  const resolved = resolvePreviewBrowserLaunch();
  const unavailable = resolved ? null : previewBrowserUnavailableError();
  return {
    available: Boolean(resolved),
    backend: resolved?.backend ?? null,
    executablePath: resolved?.executablePath ?? null,
    unavailable,
  };
}
