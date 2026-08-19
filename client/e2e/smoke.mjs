/**
 * Headless browser smoke test: the primary task, in a real browser, end to end.
 *
 *   npm run smoke --workspace client        # server and Vite must already be running
 *
 * ## Why this exists
 *
 * Everything else in this repository tests a layer. Vitest exercises the scene graph through
 * `@react-three/test-renderer`, which has no GPU, no raycaster and no compositor — so before
 * this, **clicking a turbine in the scene had never been verified anywhere**. `claude-wiki`
 * recorded that as the largest open gap in step 10's coverage. A stubbed viewport that
 * renders a `<button>` proves the workspace wiring and nothing about the picture.
 *
 * This drives Chrome. It loads the real app against the real server, waits for WebGL to
 * produce a frame, and performs T1, T2 and T3 the way a participant would: read the ranking,
 * click a machine **in the 3D scene** to trigger an actual raycast against the instanced mesh,
 * pin a baseline, change the wind, and read the deltas.
 *
 * Its companion is `accessibility.mjs`, which performs the same task without a pointer and at
 * phone size. Browser setup for both lives in `harness.mjs`.
 *
 * ## Chrome, not a downloaded browser
 *
 * `puppeteer-core` drives the Chrome already installed on the machine, so nothing fetches a
 * 150 MB browser into the repository. WebGL runs on SwiftShader — this measures *correctness*,
 * never frame rate. Step 14 owns performance, and a software rasteriser would libel it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  API_URL,
  APP_URL,
  DESKTOP,
  createChecker,
  launchBrowser,
  requireStack,
  textOf,
  waitFor,
  waitForLitCanvas,
  watchPage,
} from "./harness.mjs";

const OUT_DIR = fileURLToPath(new URL("./output/", import.meta.url));
const { check, report } = createChecker();

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await requireStack();

  const browser = await launchBrowser(DESKTOP);
  const page = await browser.newPage();
  await page.setViewport({ width: DESKTOP.width, height: DESKTOP.height, deviceScaleFactor: 1 });
  const { consoleErrors, failedRequests, badResponses, apiStatuses } = watchPage(page);

  console.log(`\nHeadless primary-task smoke test\n  app ${APP_URL}\n  api ${API_URL}\n`);

  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // ---------------------------------------------------------------- scene loads
  console.log("Scene");
  await waitFor(page, "the scene to load", () => !document.body.textContent.includes("Loading scene…"));
  // The canvas exists before R3F has measured its container, so wait for a real size rather
  // than for the element — the default 300x150 would otherwise pass as "rendering".
  await waitFor(page, "the WebGL canvas to be sized", () => {
    const canvas = document.querySelector("canvas");
    return Boolean(canvas) && canvas.width > 600 && Boolean(canvas.getContext("webgl2"));
  });
  const webgl = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    return { width: canvas.width, height: canvas.height };
  });
  check("a WebGL2 canvas is rendering", webgl.width > 600, `${webgl.width}x${webgl.height}`);

  const lit = await waitForLitCanvas(page);
  check(
    "the scene draws a lit frame rather than an empty buffer",
    lit.brightFraction > 0.2,
    `mean luminance ${lit.mean}, ${(lit.brightFraction * 100).toFixed(0)}% of pixels lit`,
  );

  // ---------------------------------------------------------------- T1: identify
  console.log("\nT1 — identify the worst turbine");
  await waitFor(page, "the ranked list", () =>
    Boolean(document.querySelector('[aria-label="Wake loss by turbine"]')),
  );
  const ranking = await page.$$eval('[aria-label="Wake loss by turbine"] button', (rows) =>
    rows.map((row) => row.textContent.replace(/\s+/g, " ").trim()),
  );
  check("the ranking lists every turbine", ranking.length >= 4, `${ranking.length} rows`);
  check("the worst turbine is named first", /t-r2c1/.test(ranking[0] ?? ""), ranking[0]);
  const rankingText = await textOf(page, '[aria-label="Wake loss by turbine"]');
  check("losses are framed as a floor", /floor, not an upper limit/i.test(rankingText));

  // ------------------------------------------------- T2: attribute, by real raycast
  console.log("\nT2 — attribute the loss, selecting in the 3D scene");
  const canvasBox = await page.$eval("canvas", (canvas) => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });

  // Sweep the viewport for a pixel that hits an instanced turbine. This is the assertion the
  // unit tests structurally cannot make: a real pointer event, through three.js's raycaster,
  // against a real InstancedMesh.
  let selected = null;
  const columns = 26;
  const rows = 16;
  outer: for (let row = 3; row < rows - 2 && !selected; row++) {
    for (let column = 2; column < columns - 1; column++) {
      const x = canvasBox.x + (canvasBox.width * (column + 0.5)) / columns;
      const y = canvasBox.y + (canvasBox.height * (row + 0.5)) / rows;
      await page.mouse.click(x, y);
      selected = await page.evaluate(() => {
        const heading = document.querySelector('[aria-label^="Analysis for turbine "]');
        return heading?.getAttribute("aria-label")?.replace("Analysis for turbine ", "") ?? null;
      });
      if (selected) break outer;
    }
  }
  check("clicking a turbine in the scene selects it", Boolean(selected), selected ?? "no hit in the sweep");

  if (selected) {
    const detail = await textOf(page, '[aria-label^="Analysis for turbine "]');
    check("the attribution names the model as the actor", /the model attributes/i.test(detail));
    check("the attribution gives a distance in rotor diameters", /\d+(\.\d+)? D upwind/.test(detail));
    check("the section states the plume-versus-rotor relation in words", /wake centreline sits at/i.test(detail));
  }

  // ---------------------------------------------------- T3: does the answer hold?
  console.log("\nT3 — test the answer under another bearing");
  await page.$$eval("button", (buttons) => {
    const target = buttons.find((button) => /pin as baseline/i.test(button.textContent ?? ""));
    target?.click();
  });
  await waitFor(page, "the baseline to pin", () => /Baseline 210°/.test(document.body.textContent ?? ""));
  check("a baseline can be pinned", true, "210°");

  await page.$eval('input[aria-label="Wind bearing"]', (input) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "215");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await waitFor(
    page,
    "the comparison to resolve",
    () => {
      const section = document.querySelector('[aria-label="Scenario comparison"]');
      return Boolean(section) && /210° → 215°/.test(section.textContent ?? "");
    },
  );
  const comparison = await textOf(page, '[aria-label="Scenario comparison"]');
  check("the comparison states both bearings", /210° → 215°/.test(comparison));
  check("the comparison answers whether the worst turbine changed", /worst turbine/i.test(comparison));
  check("the comparison reports a farm-total delta in kW", /[+−]\d[\d,]* kW/.test(comparison));
  check("the comparison reports changes in percentage points", /[+−]\d+(\.\d+)? pp/.test(comparison));
  // Every signed figure has a spoken twin, because U+2212 is skipped by some screen readers
  // and "9.2 pp" instead of "−9.2 pp" is the opposite conclusion stated confidently.
  check(
    "every signed figure says which way it moved, in words",
    /percentage points (more|less) loss/.test(comparison) && /kW (more|less)/.test(comparison),
  );
  check(
    "the delta carries the same hedge as the absolute figures",
    /floor, not an upper limit/i.test(comparison) && /no better anchored/i.test(comparison),
  );

  // ---------------------------------------------------------- annual weighting
  console.log("\nExpected annual loss");
  await waitFor(
    page,
    "the annual panel",
    () => {
      const section = document.querySelector('[aria-label="Expected annual loss"]');
      return Boolean(section) && /different claims/.test(section.textContent ?? "");
    },
  );
  const annual = await textOf(page, '[aria-label="Expected annual loss"]');
  check("expected loss and worst condition are both reported", /Expected loss/.test(annual) && /Worst condition/.test(annual));
  check("the worst condition states how rare it is", /% of hours/.test(annual));
  check("the panel states the resolution it does not have", /not resolved/i.test(annual));

  // ----------------------------------------------------------- scene import path
  console.log("\nScene import");
  const scenes = await page.$eval("#scene-select", (select) =>
    Array.from(select.options).map((option) => option.textContent?.trim()),
  );
  check("both bundled scenes are offered", scenes.length >= 2, scenes.join(" | "));

  const badScene = `${OUT_DIR}invalid-scene.json`;
  writeFileSync(badScene, JSON.stringify({ kestrel_scene: 1, id: "x", name: "x", terrain: { site_id: "ben-nevis" } }));
  const chooser = page.waitForFileChooser();
  await page.$$eval("button", (buttons) => {
    const target = buttons.find((button) => /open scene file/i.test(button.textContent ?? ""));
    target?.click();
  });
  await (await chooser).accept([badScene]);

  await waitFor(page, "the import to be rejected", () =>
    /has not changed/i.test(document.body.textContent ?? ""),
  );
  const notice = await page.evaluate(() => {
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
    return alerts.map((alert) => alert.textContent?.replace(/\s+/g, " ").trim()).join(" || ");
  });
  check("a bad scene is rejected with actionable detail", /ben-nevis|layout|wind/i.test(notice), notice.slice(0, 140));
  check("the working scene survives a failed import", /t-r2c1/.test(await textOf(page, "body")));
  // The file dialog hands focus back to a hidden input, so without an explicit hand-off the
  // next Tab restarts at the top of the document.
  const focusAfterImport = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  check("focus returns to the control that opened the file dialog", /open scene file/i.test(focusAfterImport), focusAfterImport);

  // Switching to the 16-turbine study scene exercises the whole scene-driven path: a
  // different turbine model, a different hub height, and a mesh and instance geometry built
  // from the request rather than from anything compiled into this build.
  console.log("\nScene switch");
  await page.select("#scene-select", "askervein-testing");
  await waitFor(page, "the study scene's analysis", () => {
    const ranking = document.querySelector('[aria-label="Wake loss by turbine"]');
    return Boolean(ranking) && /t-r4c4/.test(ranking.textContent ?? "");
  });
  const studyRows = await page.$$eval('[aria-label="Wake loss by turbine"] button', (rows) => rows.length);
  check("the study scene loads all sixteen turbines", studyRows === 16, `${studyRows} rows`);
  const studyLit = await waitForLitCanvas(page);
  check("the study scene draws", studyLit.brightFraction > 0.2, `${(studyLit.brightFraction * 100).toFixed(0)}% of pixels lit`);
  const studyRanking = await textOf(page, '[aria-label="Wake loss by turbine"]');
  // The scene exists because T2 is ambiguous in it, so the top two must be close together.
  // docs/design/testing-scenario.md records 25.0% and 24.7% at this bearing.
  check("the study scene's top two are close enough to require discrimination", /25\.0%/.test(studyRanking) && /24\.7%/.test(studyRanking));
  await page.screenshot({ path: `${OUT_DIR}testing-scene.png` });

  // ------------------------------------------------------------------- hygiene
  console.log("\nHygiene");
  const expectedEndpoints = ["/api/scenes", "/api/analysis", "/api/field", "/api/comparison", "/api/annual", "/api/provenance"];
  for (const endpoint of expectedEndpoints) {
    const status = [...apiStatuses.entries()].find(([path]) => path.startsWith(endpoint))?.[1];
    check(`${endpoint} answered`, status !== undefined && status < 400, String(status));
  }
  check("no failed network requests", failedRequests.length === 0, failedRequests.slice(0, 2).join("; "));
  // The deliberately invalid scene import above is expected to be rejected; nothing else is.
  const unexpected = badResponses.filter((entry) => !entry.endsWith("/api/scenes/validate"));
  check("nothing else returned an error status", unexpected.length === 0, unexpected.slice(0, 3).join("; "));
  // "Failed to load resource" duplicates the response check above with less detail. React's
  // act() warnings and SwiftShader notices are environment noise. A genuine page error is not.
  const realErrors = consoleErrors.filter(
    (message) =>
      !/Failed to load resource|act\(|SwiftShader|Deprecation|WebGL: INVALID|third-party cookie/i.test(message),
  );
  check("no uncaught console errors", realErrors.length === 0, realErrors.slice(0, 2).join("; "));

  // Wait for a composited frame before capturing: on a software rasteriser a screenshot can
  // land between frames, and a black image is a misleading artefact to leave behind.
  await waitForLitCanvas(page);
  await page.screenshot({ path: `${OUT_DIR}primary-task.png`, fullPage: false });
  console.log(`\nScreenshot: ${OUT_DIR}primary-task.png`);

  await browser.close();

  if (report() > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`\nSmoke test failed: ${error.message}`);
  process.exit(1);
});
