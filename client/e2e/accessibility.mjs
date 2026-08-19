/**
 * The primary task without a pointer, at phone size, and against automated rules.
 *
 *   npm run a11y --workspace client        # server and Vite must already be running
 *
 * ## Why this is separate from `smoke.mjs`
 *
 * `smoke.mjs` answers "does the instrument work". This answers "does it work for everyone",
 * and the two fail for different reasons: a broken raycast is a bug in the picture, an
 * unreachable control is a bug in who the picture is for. Keeping them apart means the
 * accessibility result is legible on its own rather than buried in thirty functional checks.
 *
 * `docs/design/personas.md` puts full keyboard and screen-reader operation on one persona —
 * Rowan, the community stakeholder — and says so explicitly: rows carried by a single persona
 * are the rows that get cut under schedule pressure. This file is what stops that happening
 * quietly.
 *
 * ## What it does not claim
 *
 * axe-core finds roughly a third of WCAG failures. Nothing here substitutes for the step 15
 * sessions with real participants, and a clean run means "no automated rule is violated", not
 * "this is accessible". The keyboard and mobile passes below are the part that tests
 * behaviour rather than markup.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  API_URL,
  APP_URL,
  DESKTOP,
  MOBILE,
  createChecker,
  launchBrowser,
  requireStack,
  textOf,
  waitFor,
  waitForApp,
  watchPage,
} from "./harness.mjs";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const { check, report } = createChecker();

/** WCAG 2.1 A and AA. Best-practice rules are excluded: they are opinions, not the standard. */
const AXE_OPTIONS = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
  resultTypes: ["violations"],
};

async function runAxe(page) {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (options) => {
    const results = await window.axe.run(document, options);
    const shape = (entry) => ({
      id: entry.id,
      impact: entry.impact,
      help: entry.help,
      nodes: entry.nodes.slice(0, 6).map((node) => node.target.join(" ")),
      reason: entry.nodes[0]?.any?.[0]?.message ?? "",
    });
    return {
      violations: results.violations.map(shape),
      // Reported, not swallowed. Everything the viewport draws over is a WebGL canvas, so
      // axe cannot resolve a background colour for any label on top of it and returns
      // "incomplete" rather than a pass. Hiding that would let this file print a clean run
      // while the one contrast question that actually matters here went unasked.
      incomplete: results.incomplete.map(shape),
    };
  }, AXE_OPTIONS);
}

/**
 * The contrast axe gives up on, measured from pixels instead.
 *
 * Every overlay in the viewport sits on a live 3D scene, so there is no background *colour*
 * to compute — there is a picture, and it changes as the camera moves. The mitigation the
 * project already uses is a translucent backing plate behind each overlay (the bible asks for
 * exactly that in VR); this checks the plates are actually doing their job.
 *
 * Method: screenshot the element's box from the composited page and take the 2nd and 98th
 * percentile of per-pixel relative luminance as the darkest and lightest things in it. For a
 * label on a plate those are the background and the glyphs.
 *
 * **This is a tripwire, not a WCAG verdict.** Percentiles over a box containing an icon or a
 * coloured chip are approximate in both directions, and anti-aliased text on a software
 * rasteriser is softer than on a GPU. It is set to catch "white text drifted onto bright
 * terrain", which is the failure mode a backing plate is there to prevent — and which no
 * static analysis of this page can see.
 */
const CONTRAST_TRIPWIRE = 3;

async function measureRenderedContrast(page, selector) {
  const box = await page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }).catch(() => null);
  if (!box || box.width < 4 || box.height < 4) return null;
  const shot = await page.screenshot({ encoding: "base64", clip: box });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = offscreen.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminances = [];
    for (let index = 0; index < data.length; index += 4) {
      luminances.push(0.2126 * channel(data[index]) + 0.7152 * channel(data[index + 1]) + 0.0722 * channel(data[index + 2]));
    }
    luminances.sort((a, b) => a - b);
    const at = (fraction) => luminances[Math.min(luminances.length - 1, Math.floor(luminances.length * fraction))];
    const dark = at(0.02);
    const light = at(0.98);
    return Number(((light + 0.05) / (dark + 0.05)).toFixed(2));
  }, shot);
}

/**
 * The overlays whose background is a moving 3D scene rather than a colour.
 *
 * Each is a label on a translucent backing plate. They are listed by hand because the point
 * is to name what a person has to look at, not to enumerate whatever happens to be over the
 * canvas on the day.
 */
const OVERLAY_TEXT = [
  ["the selection caption", ".scene-preview .bottom-5 .max-w-sm"],
  ["the performance readout", ".scene-preview .bottom-24"],
  ["the preview badge", ".preview-badge"],
];

function reportAxe({ violations, incomplete }) {
  for (const entry of violations) {
    console.log(`       ${entry.impact}: ${entry.id} — ${entry.help} [${entry.nodes.join(", ")}]`);
  }
  for (const entry of incomplete) {
    console.log(`       undetermined: ${entry.id} on ${entry.nodes.length} node(s) — ${entry.reason}`);
  }
}

/** What currently has focus, in enough detail to say whether it is the right thing. */
function focusInfo(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return null;
    return {
      tag: element.tagName,
      label: element.getAttribute("aria-label") ?? "",
      turbine: element.getAttribute("data-turbine") ?? "",
      id: element.id ?? "",
      pressed: element.getAttribute("aria-pressed") ?? "",
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      visible: element.getBoundingClientRect().width > 0 && element.checkVisibility?.() !== false,
    };
  });
}

/** Press Tab until something matches, so a run reports *where* it got stuck rather than that it did. */
async function tabTo(page, matches, limit = 160) {
  const seen = [];
  for (let step = 0; step < limit; step++) {
    await page.keyboard.press("Tab");
    const info = await focusInfo(page);
    if (info) seen.push(info.label || info.text.slice(0, 40));
    if (info && matches(info)) return { info, steps: step + 1, seen };
  }
  return { info: null, steps: limit, seen };
}

async function openPage(browser, viewport) {
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
  const watched = watchPage(page);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return { page, watched };
}

/** Dismiss the first-run task card so it is not a modal in front of every later check. */
async function dismissTaskCard(page) {
  await page.$$eval("button", (buttons) => {
    const skip = buttons.find((button) => button.textContent?.trim() === "Skip");
    skip?.click();
  });
}

async function main() {
  await requireStack();
  console.log(`\nAccessibility and non-pointer parity\n  app ${APP_URL}\n  api ${API_URL}\n`);

  const browser = await launchBrowser(DESKTOP);

  // ============================================================ desktop, keyboard only
  console.log("Desktop — the whole primary task, keyboard only");
  const { page, watched } = await openPage(browser, DESKTOP);
  await waitForApp(page);
  await dismissTaskCard(page);
  await page.evaluate(() => document.body.focus());

  // -------------------------------------------------------------------------- T1
  const ranking = await tabTo(page, (info) => /t-r2c1/.test(info.text) && info.tag === "BUTTON");
  check(
    "the worst turbine is reachable by Tab alone",
    Boolean(ranking.info),
    ranking.info ? `${ranking.steps} stops` : `gave up after ${ranking.steps}: ${ranking.seen.slice(-6).join(" › ")}`,
  );
  await page.keyboard.press("Enter");
  await waitFor(page, "the attribution panel", () =>
    Boolean(document.querySelector('[aria-label="Analysis for turbine t-r2c1"]')),
  );
  const detail = await textOf(page, '[aria-label="Analysis for turbine t-r2c1"]');
  check("selecting by keyboard answers T2", /the model attributes/i.test(detail));

  // ----------------------------------------------- T2 again, from inside the viewport
  // The gap step 12 exists to close: before the target layer, the only keyboard route to a
  // selection was the side panel, and the scene itself was pointer-only.
  await page.evaluate(() => document.body.focus());
  const inScene = await tabTo(page, (info) => info.turbine.length > 0);
  check(
    "the turbines in the scene are focus stops",
    Boolean(inScene.info),
    inScene.info ? `first is ${inScene.info.turbine}` : "no focusable turbine in the viewport",
  );
  if (inScene.info) {
    const spoken = inScene.info.text;
    check(
      "a focused turbine says which one it is and what it costs",
      /number \d+ of \d+ by wake loss/i.test(spoken) && /% lost/.test(spoken),
      spoken.slice(0, 90),
    );
    await page.keyboard.press("Enter");
    await waitFor(page, "the scene selection to reach the panel", () =>
      Boolean(document.querySelector('[aria-label^="Analysis for turbine "]')),
    );
    const selectedId = await page.$eval('[aria-label^="Analysis for turbine "]', (element) =>
      element.getAttribute("aria-label").replace("Analysis for turbine ", ""),
    );
    check("selecting in the scene by keyboard sets the shared selection", selectedId === inScene.info.turbine, selectedId);

    // Arrow keys still orbit while a machine is focused, which is what makes an off-frame
    // target reachable without leaving it first.
    const before = await page.$eval("#scene-summary", (element) => element.textContent);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    const after = await page.$eval("#scene-summary", (element) => element.textContent);
    check("Escape from the scene clears the selection", /No turbine is selected/i.test(after) && before !== after);
  }

  // ------------------------------------------------------------- the picture, in words
  const summary = await textOf(page, "#scene-summary");
  check("the viewport has a text equivalent", /three-dimensional view of \d+ /i.test(summary), summary.slice(0, 80));
  check("it states the redundant encoding", /brighter and more densely/i.test(summary));
  check(
    "it states that the layout does not turn with the wind",
    /layout stays fixed at \d+ degrees/i.test(summary),
  );

  // -------------------------------------------------------------------------- T3
  const pin = await tabTo(page, (info) => /pin as baseline/i.test(info.text));
  check("the baseline can be pinned by keyboard", Boolean(pin.info));
  await page.keyboard.press("Enter");
  await waitFor(page, "the baseline to pin", () => /Baseline 210°/.test(document.body.textContent ?? ""));

  // A slider is operated with arrows, not by typing a number. Five presses is the 210 → 215
  // move the alternate bearing was chosen for.
  await page.focus('input[aria-label="Wind bearing"]');
  for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowRight");
  await waitFor(page, "the comparison to resolve", () => {
    const section = document.querySelector('[aria-label="Scenario comparison"]');
    return Boolean(section) && /210° → 215°/.test(section.textContent ?? "");
  });
  const comparison = await textOf(page, '[aria-label="Scenario comparison"]');
  check("T3 is answerable with the arrow keys", /worst turbine/i.test(comparison));
  check(
    "signed columns are spoken as directions rather than glyphs",
    /percentage points (more|less) loss/.test(comparison),
  );
  const slider = await page.$eval('input[aria-label="Wind bearing"]', (input) => ({
    value: input.value,
    valuetext: input.getAttribute("aria-valuetext") ?? "",
  }));
  check("the bearing announces a direction, not only a number", /215 degrees, south-west/i.test(slider.valuetext), slider.valuetext);

  // ------------------------------------------------------------- panels and focus
  console.log("\nDesktop — panels, focus and comfort");
  await page.$$eval("button", (buttons) => {
    buttons.find((button) => button.getAttribute("aria-label") === "About this site")?.focus();
  });
  await page.keyboard.press("Enter");
  const inPanel = await focusInfo(page);
  check("opening a panel moves focus into it", inPanel?.label === "About this site", inPanel?.label ?? "focus lost");
  await page.keyboard.press("Escape");
  const returned = await focusInfo(page);
  check("Escape closes the panel and hands focus back to its trigger", returned?.label === "About this site" && returned?.tag === "BUTTON");

  const controls = await page.$$eval(".scene-controls button", (buttons) =>
    buttons.map((button) => button.getAttribute("aria-label")),
  );
  check("every viewport control is present", controls.length === 6, controls.join(", "));

  // Comfort has to survive a reload: `docs/design/wireframes.md` requires one store that XR
  // will inherit, not a per-mount read of the media query.
  await page.$$eval("button", (buttons) => {
    buttons.find((button) => button.getAttribute("aria-label") === "Open viewer settings")?.click();
  });
  await page.$$eval('input[name="particle-motion"]', (radios) => {
    radios.find((radio) => radio.value === "reduce")?.click();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForApp(page);
  const persisted = await page.$eval("#scene-summary", (element) => element.textContent ?? "");
  check("the comfort choice survives a reload", /particle motion is paused/i.test(persisted));
  check("the frozen field is described as a still snapshot", /still snapshot/i.test(persisted));

  // ---------------------------------------------------------------- axe, desktop
  console.log("\nDesktop — automated rules");
  const desktop = await runAxe(page);
  reportAxe(desktop);
  check(
    `axe-core finds no WCAG 2.1 A/AA violations (${DESKTOP.label})`,
    desktop.violations.length === 0,
    desktop.violations.map((violation) => violation.id).join(", "),
  );

  // Open every panel in turn and re-run: the disclosure, the keyboard help and the settings
  // are only in the DOM while open, so a single pass never sees most of this application.
  for (const label of ["View description and keyboard controls", "Show turbine information", "Show model accuracy and limits", "Open viewer settings"]) {
    await page.$$eval("button", (buttons, target) => {
      buttons.find((button) => button.getAttribute("aria-label") === target)?.click();
    }, label);
    const panelAxe = await runAxe(page);
    reportAxe(panelAxe);
    check(`axe-core is clean with "${label}" open`, panelAxe.violations.length === 0, panelAxe.violations.map((v) => v.id).join(", "));
    await page.keyboard.press("Escape");
  }

  // ------------------------------------------------------------- no false alarms
  // R3F renders the `<Canvas fallback>` as children of the canvas element, which is HTML's
  // own fallback slot and *is* exposed to assistive technology even while the canvas draws.
  // As an alert, "WebGL 2 is required to display this field" was announced assertively on
  // every successful load. Nothing visible on screen said it, so only a screen reader user
  // ever met it.
  const liveAlerts = await page.$$eval('[role="alert"]', (nodes) =>
    nodes.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80)),
  );
  check("a working scene raises no alerts", liveAlerts.length === 0, liveAlerts.join(" | "));

  // ------------------------------------------------- the contrast axe cannot compute
  console.log("\nDesktop — text drawn over the live scene");
  check(
    "the only undetermined rule is contrast over the canvas",
    desktop.incomplete.every((entry) => entry.id === "color-contrast"),
    desktop.incomplete.map((entry) => entry.id).join(", ") || "nothing undetermined",
  );
  for (const [name, selector] of OVERLAY_TEXT) {
    const contrast = await measureRenderedContrast(page, selector);
    check(
      `${name} stays legible over the scene`,
      contrast !== null && contrast >= CONTRAST_TRIPWIRE,
      contrast === null ? "not on screen" : `${contrast}:1 measured from pixels`,
    );
  }

  await page.close();

  // ================================================================ mobile, pointer
  console.log(`\n${MOBILE.label} — the primary task on a phone`);
  const mobile = await openPage(browser, MOBILE);
  await waitForApp(mobile.page);
  await dismissTaskCard(mobile.page);

  // The controls live behind a toggle at this width. Closed, the panel used to sit off-screen
  // under a transform and stay in the Tab order, so a keyboard user fell through the entire
  // hidden panel before reaching anything they could see.
  await mobile.page.evaluate(() => document.body.focus());
  const strayFocus = await tabTo(mobile.page, (info) => info.id === "scene-select", 25);
  check(
    "the closed control panel is out of the Tab order",
    strayFocus.info === null,
    strayFocus.info ? `reached the hidden scene picker in ${strayFocus.steps} stops` : "",
  );

  await mobile.page.$$eval("button", (buttons) => {
    buttons.find((button) => /field controls/i.test(button.textContent ?? ""))?.click();
  });
  await waitFor(mobile.page, "the mobile panel", () => {
    const select = document.querySelector("#scene-select");
    return Boolean(select) && select.checkVisibility();
  });

  const mobileRanking = await mobile.page.$$eval('[aria-label="Wake loss by turbine"] button', (rows) =>
    rows.map((row) => row.textContent.replace(/\s+/g, " ").trim()),
  );
  check("T1 is answerable on a phone", /t-r2c1/.test(mobileRanking[0] ?? ""), mobileRanking[0]?.slice(0, 60));

  await mobile.page.$$eval('[aria-label="Wake loss by turbine"] button', (rows) => rows[0]?.click());
  await waitFor(mobile.page, "the attribution panel", () =>
    Boolean(document.querySelector('[aria-label="Analysis for turbine t-r2c1"]')),
  );
  check("T2 is answerable on a phone", /the model attributes/i.test(await textOf(mobile.page, '[aria-label="Analysis for turbine t-r2c1"]')));

  await mobile.page.$$eval("button", (buttons) => {
    buttons.find((button) => /pin as baseline/i.test(button.textContent ?? ""))?.click();
  });
  await mobile.page.$eval('input[aria-label="Wind bearing"]', (input) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "215");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(mobile.page, "the comparison to resolve", () => {
    const section = document.querySelector('[aria-label="Scenario comparison"]');
    return Boolean(section) && /210° → 215°/.test(section.textContent ?? "");
  });
  check("T3 is answerable on a phone", /worst turbine/i.test(await textOf(mobile.page, '[aria-label="Scenario comparison"]')));

  // Below 640px the stylesheet used to hide every viewport control past the second, which
  // took turbine information, the accuracy record and the comfort settings off phones —
  // three things this project calls non-negotiable.
  const mobileControls = await mobile.page.$$eval(".scene-controls button", (buttons) =>
    buttons
      .filter((button) => button.checkVisibility() && button.getBoundingClientRect().width > 0)
      .map((button) => button.getAttribute("aria-label")),
  );
  check("every viewport control is still reachable on a phone", mobileControls.length === 6, mobileControls.join(", "));

  // WCAG 2.2 SC 2.5.8 asks for 24x24 CSS pixels. The bearing slider was a 3 px line.
  const smallTargets = await mobile.page.evaluate(() => {
    const interactive = Array.from(document.querySelectorAll("button, input, select, a[href]"));
    return interactive
      .filter((element) => element.checkVisibility() && !element.disabled)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { rect, element };
      })
      .filter(({ rect }) => rect.width > 0 && (rect.width < 24 || rect.height < 24))
      .map(({ rect, element }) =>
        `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      );
  });
  check("every visible control clears a 24 px target", smallTargets.length === 0, smallTargets.slice(0, 4).join(", "));

  // Six wrapping controls in an absolutely-positioned corner is exactly the arrangement that
  // silently lands on top of something else at a narrow width. The turbine targets are
  // excluded: they are `pointer-events: none` by design and two machines can project close
  // together without either becoming unclickable.
  const overlaps = await mobile.page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("button, input, select, a[href]")).filter(
      (element) => element.checkVisibility() && !element.disabled && !element.classList.contains("scene-target"),
    );
    const found = [];
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (overlapX > 2 && overlapY > 2) {
          found.push(`${a.getAttribute("aria-label") ?? a.tagName} × ${b.getAttribute("aria-label") ?? b.tagName}`);
        }
      }
    }
    return found;
  });
  check("no two controls sit on top of each other", overlaps.length === 0, overlaps.slice(0, 3).join("; "));

  console.log(`\n${MOBILE.label} — automated rules`);
  const mobileAxe = await runAxe(mobile.page);
  reportAxe(mobileAxe);
  check(
    `axe-core finds no WCAG 2.1 A/AA violations (${MOBILE.label})`,
    mobileAxe.violations.length === 0,
    mobileAxe.violations.map((violation) => violation.id).join(", "),
  );

  // ------------------------------------------------------------------- hygiene
  const errors = [...watched.consoleErrors, ...mobile.watched.consoleErrors].filter(
    (message) => !/Failed to load resource|act\(|SwiftShader|Deprecation|WebGL: INVALID|third-party cookie/i.test(message),
  );
  check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join("; "));

  await browser.close();
  if (report() > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`\nAccessibility run failed: ${error.message}`);
  process.exit(1);
});
