/**
 * Shared plumbing for the headless browser suites.
 *
 * Two suites use it: `smoke.mjs`, which proves the primary task works, and
 * `accessibility.mjs`, which proves it works without a pointer, at phone size, and without
 * violating the automated accessibility rules. They launch the same browser the same way, so
 * a difference between their results is a difference in the app rather than in the setup.
 */

import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

export const APP_URL = process.env.KESTREL_APP_URL ?? "http://127.0.0.1:5173/";
export const API_URL = process.env.KESTREL_API_URL ?? "http://127.0.0.1:8787";

/** Desktop and phone. The phone size is an iPhone 14's CSS viewport. */
export const DESKTOP = { width: 1600, height: 1000, label: "desktop 1600x1000" };
export const MOBILE = { width: 390, height: 844, label: "mobile 390x844" };

/**
 * Chrome executable.
 *
 * Resolved from the platform's usual location, overridable for CI. Never downloaded: the
 * point of `puppeteer-core` over `puppeteer` is that the browser is a system dependency.
 */
export function findChrome() {
  const override = process.env.CHROME_PATH;
  if (override) return override;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.");
}

export function launchBrowser({ width, height } = DESKTOP) {
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      "--headless=new",
      // WebGL2 in headless needs a rasteriser. SwiftShader is software: correct, and slow.
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--no-sandbox",
      `--window-size=${width},${height}`,
    ],
  });
}

/** Fail early and clearly if the stack is not up, rather than after a 45 s WebGL timeout. */
export async function requireStack() {
  const health = await fetch(`${API_URL}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`Kestrel server is not answering at ${API_URL}. Start it first.`);
  const app = await fetch(APP_URL).catch(() => null);
  if (!app?.ok) throw new Error(`No app at ${APP_URL}. Start the Vite dev server first.`);
}

export function createChecker() {
  const state = { checks: 0, failures: 0 };
  return {
    state,
    check(label, condition, detail = "") {
      state.checks++;
      if (condition) {
        console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
      } else {
        state.failures++;
        console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
      }
    },
    report() {
      console.log(`\n${state.checks - state.failures}/${state.checks} checks passed`);
      return state.failures;
    },
  };
}

/** Wait for a predicate evaluated in the page, with a useful message on timeout. */
export async function waitFor(page, description, fn, timeout = 45_000) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 250 });
  } catch {
    throw new Error(`timed out waiting for ${description}`);
  }
}

export const textOf = (page, selector) =>
  page.$eval(selector, (element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "");

/**
 * Wait until the viewport contains a lit frame, and report how lit.
 *
 * Measured from a screenshot rather than `gl.readPixels`, because the drawing buffer is not
 * preserved after a frame — reading it back yields a cleared buffer, which is
 * indistinguishable from a scene that never built. The compositor's output is what a person
 * would see, so it is what to assert on.
 *
 * Without this, every DOM check would pass against a black viewport: the panels are driven by
 * JSON and would be perfectly happy if nothing were ever drawn. Under SwiftShader a screenshot
 * can also land between frames, so this retries.
 */
export async function waitForLitCanvas(page, attempts = 25) {
  let stats = { mean: 0, brightFraction: 0 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const clip = await page.$eval("canvas", (canvas) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    const shot = await page.screenshot({ encoding: "base64", clip });
    stats = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = offscreen.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let sum = 0;
      let brightPixels = 0;
      let counted = 0;
      for (let index = 0; index < data.length; index += 4 * 7) {
        const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
        sum += luminance;
        if (luminance > 40) brightPixels++;
        counted++;
      }
      return { mean: Number((sum / counted).toFixed(1)), brightFraction: brightPixels / counted };
    }, shot);
    if (stats.brightFraction > 0.2) return stats;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return stats;
}

/** Collect page errors and bad responses the way both suites want them. */
export function watchPage(page) {
  const consoleErrors = [];
  const failedRequests = [];
  const badResponses = [];
  const apiStatuses = new Map();

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    // `net::ERR_ABORTED` is our own AbortController doing its job. React StrictMode mounts
    // every effect twice in development, so each hook aborts its first request by design —
    // treating that as a failure would make the check fail permanently and mean nothing.
    if (request.failure()?.errorText === "net::ERR_ABORTED") return;
    failedRequests.push(`${request.url()} ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/")) apiStatuses.set(url.pathname, response.status());
    // Tracked here rather than through console text, because "Failed to load resource: 404"
    // does not say *which* resource and would make this check unactionable.
    if (response.status() >= 400) badResponses.push(`${response.status()} ${url.pathname}`);
  });

  return { consoleErrors, failedRequests, badResponses, apiStatuses };
}

/** Wait for the app to have a scene, an analysis, and a canvas that has been sized. */
export async function waitForApp(page) {
  await waitFor(page, "the scene to load", () => !document.body.textContent.includes("Loading scene…"));
  await waitFor(page, "the WebGL canvas to be sized", () => {
    const canvas = document.querySelector("canvas");
    return Boolean(canvas) && canvas.width > 300 && Boolean(canvas.getContext("webgl2"));
  });
  await waitFor(page, "the ranked list", () =>
    Boolean(document.querySelector('[aria-label="Wake loss by turbine"]')),
  );
}
