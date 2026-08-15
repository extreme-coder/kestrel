import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Compass, FlaskConical, Gauge, Info, Keyboard, Layers3, Move3d, Pause, RotateCcw, Settings2, Wind, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverlayPanel } from "@/components/ui/overlay-panel";
import { Separator } from "@/components/ui/separator";
import { PrimaryTaskCard, hasSeenPrimaryTask } from "@/features/analysis/PrimaryTaskCard";
import { TurbineDetail } from "@/features/analysis/TurbineDetail";
import { TurbineRanking } from "@/features/analysis/TurbineRanking";
import { findTurbine } from "@/features/analysis/analysis";
import type { AnalysisRecord } from "@/features/analysis/analysis";
import { kilowatts, percent, speed } from "@/features/analysis/format";
import { useAnalysis } from "@/features/analysis/useAnalysis";
import type { AnalysisState } from "@/features/analysis/useAnalysis";
import { ModelDisclosure } from "@/features/provenance/ModelDisclosure";
import { ProvenanceTag } from "@/features/provenance/ProvenanceTag";
import { useProvenance } from "@/features/provenance/useProvenance";
import type { ProvenanceState } from "@/features/provenance/useProvenance";
import { AnnualPanel } from "@/features/scenario/AnnualPanel";
import { ComparisonPanel } from "@/features/scenario/ComparisonPanel";
import { ScenarioPicker } from "@/features/scenario/ScenarioPicker";
import { useScenario } from "@/features/scenario/useScenario";
import type { Scenario } from "@/features/scenario/useScenario";
import type { FieldRequest } from "@/features/scenario/scenario";
import type { SceneTerrain } from "@/features/site/SiteScene";
import { SpatialFieldViewport } from "@/features/spatial-field/SpatialFieldViewport";
import { SceneTargets } from "./SceneTargets";
import { describeScene } from "./sceneSummary";
import { useComfortPreferences } from "./preferences";
import type { ComfortPreferences, MotionPreference } from "./preferences";
import { useElementSize } from "./useElementSize";

const SPEED_STOPS = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];

function Brand() {
  return (
    <a href="/" className="group flex items-center gap-3" aria-label="Kestrel home">
      <span className="grid size-9 place-items-center rounded-full border border-white/15 bg-white/5 text-lime-300 transition-transform group-hover:-rotate-12"><Wind aria-hidden="true" className="size-4" /></span>
      <span><span className="block font-display text-xl leading-none tracking-tight">Kestrel</span><span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">Spatial wind lab</span></span>
    </a>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return <div><dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</dt><dd className="mt-1 font-display text-2xl tracking-tight">{value} <span className="font-sans text-xs text-muted-foreground">{unit}</span></dd></div>;
}

function bearingLabel(bearing: number) {
  const labels = ["North", "North-east", "East", "South-east", "South", "South-west", "West", "North-west"];
  return labels[Math.round(bearing / 45) % labels.length];
}

/**
 * The analysis region: the ranked list, or one turbine's attribution.
 *
 * Two states of one panel rather than two panels, following the flow in
 * `docs/design/wireframes.md` — the list answers T1, selecting a row moves to the
 * attribution that answers T2, and "All turbines" comes back.
 */
function AnalysisResults({ analysis, selectedId, onSelect, onClear }: {
  analysis: AnalysisState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  if (analysis.status === "loading") {
    return <p className="text-xs text-muted-foreground" role="status">Computing turbine losses…</p>;
  }
  if (analysis.status === "error") {
    // Visible, like the provenance failure. Leaving the last bearing's figures on screen
    // beside a newly drawn field would be worse than showing none.
    return (
      <p className="text-xs leading-relaxed text-amber-200/80" role="alert">
        {analysis.error}. Turbine figures are unavailable for this bearing. Start the Kestrel server and retry.
      </p>
    );
  }
  const selected = findTurbine(analysis.record, selectedId);
  return selected
    ? <TurbineDetail record={analysis.record} turbine={selected} onSelect={onSelect} onClear={onClear} />
    : <TurbineRanking record={analysis.record} selectedId={selectedId} onSelect={onSelect} />;
}

function AnalysisPanel({ scenario, comfort, analysis, selectedId, onSelect, onClear }: {
  scenario: Scenario;
  comfort: ComfortPreferences;
  analysis: AnalysisState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const record = analysis.status === "ready" ? analysis.record : null;
  const bearing = scenario.bearing;
  const onBearingChange = scenario.setBearing;
  const scene = scenario.state.status === "ready" ? scenario.state.scene : null;
  return (
    <aside className="analysis-panel" aria-label="Wind field controls">
      <div>
        <p className="eyebrow">Active study</p>
        {/* Not a button. It was one, with a chevron, and it did nothing — a keyboard user
            reached it, pressed it, and got no feedback of any kind. */}
        <p className="mt-3">
          <span className="block font-display text-2xl">Askervein Hill</span>
          <span className="mt-1 block text-xs text-muted-foreground">South Uist, Scotland · Site A</span>
        </p>
      </div>
      <Separator />
      <ScenarioPicker scenario={scenario} />
      <Separator />
      <div>
        <div className="flex items-center justify-between"><p className="eyebrow">Wind bearing</p><Compass aria-hidden="true" className="size-4 text-lime-300" /></div>
        <div className="mt-4 flex items-end justify-between gap-4"><output className="font-display text-5xl leading-none tracking-[-0.05em]" htmlFor="wind-bearing">{bearing}°</output><p className="pb-1 text-xs text-muted-foreground">{bearingLabel(bearing)}</p></div>
        <input
          id="wind-bearing"
          className="range-control mt-6"
          aria-label="Wind bearing"
          aria-valuetext={`${bearing} degrees, ${bearingLabel(bearing)}`}
          type="range"
          min="0"
          max="359"
          value={bearing}
          onChange={(event) => onBearingChange(Number(event.currentTarget.value))}
          style={{ "--range-progress": `${bearing / 3.59}%` } as React.CSSProperties}
        />
        <div className="mt-2 flex justify-between text-[10px] font-semibold tracking-widest text-muted-foreground"><span>0° N</span><span>180° S</span><span>359° N</span></div>
        {/* The array stays where it was built while the wind turns. Without saying so, a user
            watching the losses change has no way to know the farm did not move. */}
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          The layout stays fixed at {record ? record.layout.orientation_bearing_deg : 210}°, the bearing it was
          designed against. Only the wind turns.
        </p>
      </div>
      <Separator />
      <AnalysisResults analysis={analysis} selectedId={selectedId} onSelect={onSelect} onClear={onClear} />
      <Separator />
      <ComparisonPanel request={scenario.request} selectedId={selectedId} onSelect={onSelect} />
      <Separator />
      <AnnualPanel scene={scene} />
      <Separator />
      <div>
        <p className="eyebrow">Field conditions</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5">
          <Metric label="Wind speed" value={record ? record.wind.speed_ms.toFixed(1) : "—"} unit="m/s" />
          <Metric label="Turbulence" value={record ? (record.wind.turbulence_intensity * 100).toFixed(0) : "—"} unit="%" />
          <Metric label="Turbines" value={record ? String(record.layout.count) : "—"} unit={record ? record.layout.turbine_name : "—"} />
          <Metric label="Particles" value="64k" unit={comfort.reducedMotion ? "still" : "live"} />
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Speed and turbulence are inputs to the model, not readings taken at Askervein.</p>
      </div>
      <Separator />
      <div>
        <div className="flex items-center justify-between"><p className="eyebrow">Velocity</p><span className="text-[10px] text-muted-foreground">m/s</span></div>
        <div className="mt-4 h-2 rounded-full" aria-hidden="true" style={{ background: `linear-gradient(90deg, ${SPEED_STOPS.join(",")})` }} />
        <div className="mt-2 flex justify-between text-[10px] tabular-nums text-muted-foreground" aria-hidden="true"><span>0</span><span>5</span><span>10</span><span>15+</span></div>
        {/* The legend is a gradient and four numbers, which is nothing at all without sight of
            it. This sentence is the legend for everyone else, and it is also where the second
            encoding is stated — persona Rowan is the only persona who requires that, which is
            exactly why it is written down rather than left to the picture. */}
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Speed runs from 0 m/s to 15 m/s and above. Faster air is drawn brighter — dark purple through teal to
          yellow — <strong className="font-semibold text-white/80">and more densely</strong>. Slower air is darker
          and sparser, so a wake reads as a thinning of the field as well as a change of colour, and survives
          monochrome vision.
        </p>
      </div>
      <Button
        className="mt-auto w-full"
        variant={comfort.reducedMotion ? "default" : "outline"}
        onClick={() => comfort.setMotion(comfort.reducedMotion ? "full" : "reduce")}
        aria-pressed={comfort.reducedMotion}
      >
        <Pause aria-hidden="true" className="size-3.5" /> {comfort.reducedMotion ? "Resume particles" : "Pause particles"}
      </Button>
    </aside>
  );
}

/**
 * The ground the scene draws, taken from the request the server solved.
 *
 * Before step 11 the mesh came from an asset compiled into the client and the solve from a
 * copy of it on the server, kept in step by a test. Reading it off the request means an
 * imported scene renders its own hill, and the drawn ground is the ground the flow was
 * computed over by construction rather than by agreement.
 */
function sceneTerrain(request: FieldRequest): SceneTerrain {
  return {
    columns: request.terrain.columns,
    rows: request.terrain.rows,
    cellSizeEastingM: request.terrain.cell_size_easting_m,
    cellSizeNorthingM: request.terrain.cell_size_northing_m,
    elevationsM: request.terrain.elevations_m,
  };
}

type ViewState = { yaw: number; pitch: number; zoom: number };

const INITIAL_VIEW: ViewState = { yaw: 0, pitch: 0, zoom: 1 };

/**
 * Pointer travel, in pixels, before a press becomes a camera drag.
 *
 * Without it every click on a turbine also captured the pointer on the viewport, which
 * stopped the canvas ever seeing the pointerup — so the scene could be orbited but nothing
 * in it could be selected.
 */
const DRAG_THRESHOLD_PX = 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Which floating panel is open. One at a time: several of them occupy the same corner. */
type PanelId = "site" | "settings" | "turbines" | "accuracy" | "keys";

function PanelHeader({ eyebrow, title, closeLabel, onClose }: {
  eyebrow: string;
  title: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div><p className="eyebrow text-lime-300">{eyebrow}</p><h2 className="mt-2 font-display text-xl">{title}</h2></div>
      <Button size="icon" variant="ghost" className="-mr-2 -mt-2" onClick={onClose} aria-label={closeLabel}><X className="size-4" /></Button>
    </div>
  );
}

function SiteInfo({ onClose, onOpenAccuracy }: { onClose: () => void; onOpenAccuracy: () => void }) {
  return (
    <OverlayPanel label="About this site" className="site-info" onClose={onClose}>
      <PanelHeader eyebrow="About this site" title="Why Askervein Hill?" closeLabel="Close site information" onClose={onClose} />
      <p className="mt-3 text-sm leading-relaxed text-white/70">The 1982&ndash;83 field campaign measured wind over this hill, so the model can be compared with instruments rather than with itself.</p>
      <Separator className="my-4" />
      <h3 className="text-sm font-semibold">Terrain <ProvenanceTag provenance="measured" /></h3>
      <p className="mt-1.5 text-sm leading-relaxed text-white/70">Copernicus DEM GLO&#8209;30, a 2 km square at 62.5 m spacing. The same elevations drive the picture and the calculation.</p>
      <h3 className="mt-4 text-sm font-semibold">What the campaign checks</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-white/70">Hilltop speed-up matches the measured value at 34 m above ground. Closer to the ground the model reads up to a third low, and it does not reproduce the slowdown in the hill&rsquo;s lee.</p>
      <h3 className="mt-4 text-sm font-semibold">What it does not check</h3>
      {/* The composition the viewer draws is the one thing nothing anchors. Saying it here
          rather than only in the disclosure keeps it beside the picture it qualifies. */}
      <p className="mt-1.5 text-sm leading-relaxed text-white/70">Wakes over terrain. Askervein has no turbines and the offshore array the wake model was checked against has no hill, so the combination on screen has never been compared with a measurement.</p>
      <Button variant="outline" className="mt-4 w-full" onClick={onOpenAccuracy}><FlaskConical aria-hidden="true" className="size-3.5" /> View accuracy and limits</Button>
    </OverlayPanel>
  );
}

const MOTION_CHOICES: { value: MotionPreference; label: string; detail: string }[] = [
  { value: "system", label: "Follow this device", detail: "Use the reduced-motion setting from your operating system." },
  { value: "reduce", label: "Freeze the particles", detail: "The field is shown as a still snapshot. Every figure stays live." },
  { value: "full", label: "Full motion", detail: "Particles drift along the modelled flow." },
];

function ComfortPanel({ comfort, onClose }: { comfort: ComfortPreferences; onClose: () => void }) {
  return (
    <OverlayPanel label="Viewer settings" className="site-info" onClose={onClose}>
      <PanelHeader eyebrow="Comfort" title="Viewer settings" closeLabel="Close viewer settings" onClose={onClose} />
      {/* Three states, not a checkbox. "Follow this device" has to be distinguishable from a
          choice that happens to agree with the device today, or a user who changes the OS
          setting later finds this one silently overriding it. */}
      <fieldset className="mt-5">
        <legend className="text-sm font-semibold">Particle motion</legend>
        <div className="mt-3 flex flex-col gap-2" role="radiogroup" aria-label="Particle motion">
          {MOTION_CHOICES.map((choice) => (
            <label key={choice.value} className="comfort-choice">
              <input
                type="radio"
                name="particle-motion"
                className="mt-0.5 size-4 shrink-0 accent-lime-300"
                value={choice.value}
                checked={comfort.motion === choice.value}
                onChange={() => comfort.setMotion(choice.value)}
              />
              <span>
                <span className="block text-sm font-medium">{choice.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-white/60">{choice.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        This device currently asks for {comfort.systemPrefersReduced ? "reduced" : "full"} motion. Your choice is
        remembered on this browser and applies wherever the field is shown.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground" role="status">
        {comfort.reducedMotion
          ? "Particles are frozen. The field on screen is a still snapshot of the same velocity volume."
          : "Particles are moving."}
      </p>
    </OverlayPanel>
  );
}

function KeyboardPanel({ summary, onClose }: { summary: string; onClose: () => void }) {
  return (
    <OverlayPanel label="View description and keyboard controls" className="model-disclosure" onClose={onClose}>
      <PanelHeader eyebrow="This view" title="What is on screen, and how to drive it" closeLabel="Close view description" onClose={onClose} />
      {/* The same sentence the viewport is described by. Shown rather than hidden, because
          screen-reader-only prose nobody can see is prose nobody notices has gone stale. */}
      <p className="mt-4 text-sm leading-relaxed text-white/75">{summary}</p>
      <Separator className="my-4" />
      <h3 className="text-sm font-semibold">Keyboard</h3>
      <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt className="font-semibold tabular-nums">Tab</dt><dd className="text-white/70">Move through the controls, including every turbine in the scene.</dd>
        <dt className="font-semibold tabular-nums">Enter</dt><dd className="text-white/70">Select the focused turbine and open its attribution.</dd>
        <dt className="font-semibold tabular-nums">← → ↑ ↓</dt><dd className="text-white/70">Rotate the view.</dd>
        <dt className="font-semibold tabular-nums">+ −</dt><dd className="text-white/70">Zoom in and out.</dd>
        <dt className="font-semibold tabular-nums">0</dt><dd className="text-white/70">Reset the view to where it started.</dd>
        <dt className="font-semibold tabular-nums">Esc</dt><dd className="text-white/70">Close a panel, or clear the selected turbine.</dd>
      </dl>
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        Every figure the scene shows is also in the ranked list, the attribution panel and the comparison table,
        as text. Nothing in the primary task needs a pointer or a headset.
      </p>
    </OverlayPanel>
  );
}

function TurbineInfo({ analysis, onClose }: { analysis: AnalysisState; onClose: () => void }) {
  const record = analysis.status === "ready" ? analysis.record : null;
  return (
    <OverlayPanel label="Turbine information" className="turbine-info" onClose={onClose}>
      <PanelHeader
        eyebrow="Demonstration layout"
        title={record ? `${record.layout.count} ${record.layout.turbine_name} turbines` : "Four V112 turbines"}
        closeLabel="Close turbine information"
        onClose={onClose}
      />
      {/* The terrain is real and the turbines are not. Rendered together they read as a
          wind farm, so the panel that names them has to say otherwise. */}
      <p className="mt-3 text-sm leading-relaxed text-white/70">No wind farm exists at Askervein. These turbines are placed for demonstration, and their figures describe that invented layout <ProvenanceTag provenance="computed" /> rather than the site.</p>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <Metric label="Rotor" value={record ? String(Math.round(record.layout.rotor_diameter_m)) : "112"} unit="m" />
        <Metric label="Hub" value={record?.turbines[0] ? String(Math.round(record.turbines[0].hub_height_m)) : "100"} unit="m" />
        <Metric label="Farm loss" value={record ? percent(record.farm.farm_wake_loss_fraction, 0) : "—"} unit="" />
        <Metric label="Net" value={record ? kilowatts(record.farm.total_net_power_kw).replace(" kW", "") : "—"} unit="kW" />
      </dl>
    </OverlayPanel>
  );
}

function ScenePreview({ request, analysis, selectedId, onSelect, comfort, provenance, scenario }: {
  request: unknown;
  analysis: AnalysisState;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  comfort: ComfortPreferences;
  provenance: ProvenanceState;
  scenario: Scenario;
}) {
  const [view, setView] = useState(INITIAL_VIEW);
  const [isDragging, setIsDragging] = useState(false);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [performanceOpen, setPerformanceOpen] = useState(true);
  const [taskOpen, setTaskOpen] = useState(() => !hasSeenPrimaryTask());
  const viewport = useRef<HTMLElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; active: boolean; pointerId: number } | null>(null);
  // Focus has to go back where it came from when a panel closes. Keyed by panel because the
  // triggers sit in one cluster and any of them can be the one that opened the current panel.
  const triggers = useRef(new Map<PanelId, HTMLButtonElement | null>());
  const worldSize = useElementSize(world);

  const registerTrigger = (id: PanelId) => (node: HTMLButtonElement | null) => {
    triggers.current.set(id, node);
  };

  const closePanel = useCallback(() => {
    setPanel(null);
    // The trigger is never conditionally rendered, so it is still there to receive focus.
    // Without this the panel vanishes and focus falls back to the document body, which drops
    // a keyboard user at the top of the page.
    if (panel) triggers.current.get(panel)?.focus();
  }, [panel]);

  const togglePanel = (id: PanelId) => {
    setPanel((current) => (current === id ? null : id));
  };

  const updateView = (changes: Partial<ViewState>) => {
    setView((current) => ({ ...current, ...changes }));
  };

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button, input, label, a")) return;
    drag.current = { x: event.clientX, y: event.clientY, active: false, pointerId: event.pointerId };
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      // Capture only now: doing it on pointerdown steals the pointerup from the canvas, and
      // with it every click on a turbine.
      event.currentTarget.setPointerCapture(state.pointerId);
      state.active = true;
      setIsDragging(true);
    }
    state.x = event.clientX;
    state.y = event.clientY;
    setView((current) => ({
      ...current,
      yaw: current.yaw + dx * 0.08,
      pitch: clamp(current.pitch - dy * 0.05, -5, 5),
    }));
  };

  const endDrag = () => {
    drag.current = null;
    setIsDragging(false);
  };

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setView((current) => ({ ...current, zoom: clamp(current.zoom - event.deltaY * 0.001, 0.78, 1.35) }));
    };
    // Capture before R3F's canvas event layer sees trackpad pinch/wheel input. In Chrome,
    // pinch-to-zoom arrives as a cancelable ctrl+wheel event; a bubbling listener can be
    // too late if the canvas consumes it first.
    element.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => element.removeEventListener("wheel", handleWheel, true);
  }, []);

  /**
   * Camera and selection keys.
   *
   * These bubble up from the turbine targets as well as from the viewport itself, which is
   * deliberate: a keyboard user who lands on a machine that is behind the camera needs to be
   * able to rotate the view without leaving it first.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && selectedId) {
      event.preventDefault();
      onSelect(null);
      return;
    }
    const changes: Partial<ViewState> = {};
    if (event.key === "ArrowLeft") changes.yaw = view.yaw - 2;
    else if (event.key === "ArrowRight") changes.yaw = view.yaw + 2;
    else if (event.key === "ArrowUp") changes.pitch = clamp(view.pitch + 1, -5, 5);
    else if (event.key === "ArrowDown") changes.pitch = clamp(view.pitch - 1, -5, 5);
    else if (event.key === "+" || event.key === "=") changes.zoom = clamp(view.zoom + 0.08, 0.78, 1.35);
    else if (event.key === "-") changes.zoom = clamp(view.zoom - 0.08, 0.78, 1.35);
    else if (event.key === "0") {
      event.preventDefault();
      setView(INITIAL_VIEW);
      return;
    } else return;
    event.preventDefault();
    updateView(changes);
  };

  const record: AnalysisRecord | null = analysis.status === "ready" ? analysis.record : null;
  const selected = record ? findTurbine(record, selectedId) : null;
  const terrain = scenario.state.status === "ready" ? sceneTerrain(scenario.state.request) : null;
  const summary = useMemo(
    () => describeScene({
      record,
      selectedId,
      bearingDeg: scenario.bearing,
      reducedMotion: comfort.reducedMotion,
    }),
    [record, selectedId, scenario.bearing, comfort.reducedMotion],
  );

  return (
    <section
      ref={viewport}
      className={isDragging ? "scene-preview is-dragging" : "scene-preview"}
      aria-label="Three-dimensional wind field viewport"
      aria-describedby="scene-summary"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    >
      {/* The canvas has no children in the accessibility tree, so this paragraph is the only
          account of the picture an assistive technology can reach. It is polite rather than
          assertive: it changes on every bearing tick, and an assertive region would talk over
          the user scrubbing the control that changes it. */}
      <p id="scene-summary" className="sr-only" role="status">{summary}</p>
      <div className="scene-world" data-testid="scene-world" ref={world}>
        {scenario.state.status === "loading" ? (
          <div className="field-state" role="status">Loading scene…</div>
        ) : scenario.state.status === "error" ? (
          <div className="field-state field-error" role="alert">
            {scenario.state.error}. Start the Kestrel server and reload.
          </div>
        ) : (
          <SpatialFieldViewport
            request={request}
            analysis={analysis}
            selectedId={selectedId}
            onSelect={onSelect}
            reducedMotion={comfort.reducedMotion}
            view={view}
            terrain={sceneTerrain(scenario.state.request)}
          />
        )}
        <SceneTargets
          record={record}
          terrain={terrain}
          view={view}
          size={worldSize}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      </div>
      <div className="preview-badge"><span className="size-1.5 rounded-full bg-lime-300 shadow-[0_0_12px_#bef264]" aria-hidden="true" /> Desktop preview</div>
      <div className="scene-controls">
        <Button ref={registerTrigger("keys")} size="icon" variant="outline" onClick={() => togglePanel("keys")} aria-label="View description and keyboard controls" aria-expanded={panel === "keys"}><Keyboard className="size-4" /></Button>
        <Button ref={registerTrigger("site")} size="icon" variant="outline" onClick={() => togglePanel("site")} aria-label="About this site" aria-expanded={panel === "site"}><Info className="size-4" /></Button>
        <Button size="icon" variant="outline" onClick={() => setView(INITIAL_VIEW)} aria-label="Reset view"><RotateCcw className="size-4" /></Button>
        <Button ref={registerTrigger("turbines")} size="icon" variant="outline" onClick={() => togglePanel("turbines")} aria-label="Show turbine information" aria-expanded={panel === "turbines"}><Layers3 className="size-4" /></Button>
        <Button ref={registerTrigger("accuracy")} size="icon" variant="outline" onClick={() => togglePanel("accuracy")} aria-label="Show model accuracy and limits" aria-expanded={panel === "accuracy"}><FlaskConical className="size-4" /></Button>
        <Button ref={registerTrigger("settings")} size="icon" variant="outline" onClick={() => togglePanel("settings")} aria-label="Open viewer settings" aria-expanded={panel === "settings"}><Settings2 className="size-4" /></Button>
      </div>
      {taskOpen ? <PrimaryTaskCard turbineCount={record?.layout.count ?? 4} bearingDeg={record?.wind.bearing_deg ?? 210} onDismiss={() => setTaskOpen(false)} /> : null}
      {panel === "keys" ? <KeyboardPanel summary={summary} onClose={closePanel} /> : null}
      {panel === "site" ? <SiteInfo onClose={closePanel} onOpenAccuracy={() => setPanel("accuracy")} /> : null}
      {panel === "settings" ? <ComfortPanel comfort={comfort} onClose={closePanel} /> : null}
      {panel === "turbines" ? <TurbineInfo analysis={analysis} onClose={closePanel} /> : null}
      {panel === "accuracy" ? <ModelDisclosure state={provenance} onClose={closePanel} /> : null}
      {performanceOpen ? <div className="absolute bottom-24 right-5 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-white/60 backdrop-blur-md">60 FPS target · 16.7 ms budget</div> : null}
      <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between gap-4">
        <div className="max-w-sm rounded-2xl border border-white/10 bg-black/30 p-4 backdrop-blur-md">
          <div className="flex items-center gap-2"><p className="eyebrow text-lime-300">{selected ? "Selected" : "Live field"}</p><ProvenanceTag provenance="computed" /></div>
          {selected
            ? <p className="mt-2 text-sm leading-relaxed text-white/70">{selected.id} · {speed(selected.incoming_speed_ms)} at the rotor · {percent(selected.wake_loss_fraction)} of its output lost to modelled wakes. Press Escape to clear.</p>
            : <p className="mt-2 text-sm leading-relaxed text-white/70">Particles follow a modelled velocity field, not recorded wind. Select a turbine in the scene or the list to see what the model says is waking it.</p>}
        </div>
        <button type="button" onClick={() => setPerformanceOpen((open) => !open)} aria-expanded={performanceOpen} className="hidden rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[10px] text-white/60 backdrop-blur-md sm:block">{performanceOpen ? "Hide performance" : "Show performance"}</button>
      </div>
    </section>
  );
}

export function ViewerWorkspace() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Remembered across sessions and shared with step 13's XR path, rather than re-read from
  // the media query on every mount. See `preferences.ts`.
  const comfort = useComfortPreferences();
  // One request object describes one scene, and it now comes from a scene file rather than
  // from a constant compiled into this build. The volume and the per-turbine figures are read
  // off it by two endpoints, which is what keeps the picture and the table talking about the
  // same farm.
  const scenario = useScenario();
  const request = scenario.request;
  const analysis = useAnalysis(request);
  // Selection belongs to a scene, not to the session. Turbine ids are positional — `t-r2c1`
  // exists in both bundled scenes and means a different machine in each — so carrying a
  // selection across a scene change would silently re-point the attribution panel at a
  // different turbine of the same name.
  const sceneId = scenario.state.status === "ready" ? scenario.state.sceneId : null;
  useEffect(() => {
    setSelectedId(null);
  }, [sceneId]);
  // Fetched once at the workspace root rather than inside the panel, so the model version
  // is available to anything that displays a number without each consumer refetching.
  const provenance = useProvenance();
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex h-[76px] items-center justify-between border-b border-border px-5 lg:px-8">
        <Brand />
        <nav className="flex items-center gap-1" aria-label="Primary navigation">
          {/* Disabled rather than dead. It was an enabled control that did nothing, which is
              worse for a keyboard or screen-reader user than an honest unavailable one. */}
          <Button variant="outline" disabled aria-describedby="immersive-status">
            <Move3d className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Enter immersive view</span>
            <span className="sr-only">Enter immersive view</span>
          </Button>
          <span id="immersive-status" className="sr-only">
            Not available yet. Every part of the analysis works here without a headset.
          </span>
        </nav>
      </header>
      <div className="workspace-grid">
        <div className={panelOpen ? "mobile-panel is-open" : "mobile-panel"}>
          <AnalysisPanel
            scenario={scenario}
            comfort={comfort}
            analysis={analysis}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onClear={() => setSelectedId(null)}
          />
        </div>
        <ScenePreview request={request} analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} comfort={comfort} provenance={provenance} scenario={scenario} />
        <aside className="status-rail" aria-label="Performance status"><div className="flex items-center gap-2"><Gauge className="size-3.5 text-lime-300" aria-hidden="true" /><span>Target 60 FPS</span></div><span className="text-muted-foreground">Desktop budget 16.7 ms</span><span className="text-muted-foreground">{provenance.status === "ready" ? `Model ${provenance.record.model_version}` : "Model version unavailable"}</span><span className="ml-auto text-muted-foreground">WebGL 2</span></aside>
      </div>
      <Button className="fixed bottom-5 left-5 z-50 lg:hidden" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}><Settings2 className="size-4" aria-hidden="true" /> {panelOpen ? "Close controls" : "Field controls"}</Button>
    </main>
  );
}
