import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { ChevronDown, Compass, FlaskConical, Gauge, Info, Layers3, Move3d, Pause, RotateCcw, Settings2, Wind, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { PrimaryTaskCard, hasSeenPrimaryTask } from "@/features/analysis/PrimaryTaskCard";
import { TurbineDetail } from "@/features/analysis/TurbineDetail";
import { TurbineRanking } from "@/features/analysis/TurbineRanking";
import { findTurbine } from "@/features/analysis/analysis";
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

const SPEED_STOPS = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];

function Brand() {
  return (
    <a href="/" className="group flex items-center gap-3" aria-label="Kestrel home">
      <span className="grid size-9 place-items-center rounded-full border border-white/15 bg-white/5 text-lime-300 transition-transform group-hover:-rotate-12"><Wind aria-hidden="true" className="size-4" /></span>
      <span><span className="block font-display text-xl leading-none tracking-tight">Kestrel</span><span className="mt-1 block text-[9px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">Spatial wind lab</span></span>
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

function AnalysisPanel({ scenario, reducedMotion, onReducedMotionChange, analysis, selectedId, onSelect, onClear }: {
  scenario: Scenario;
  reducedMotion: boolean;
  onReducedMotionChange: (reduced: boolean) => void;
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
        <button className="mt-3 flex w-full items-center justify-between text-left" type="button">
          <span><span className="block font-display text-2xl">Askervein Hill</span><span className="mt-1 block text-xs text-muted-foreground">South Uist, Scotland · Site A</span></span>
          <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
        </button>
      </div>
      <Separator />
      <ScenarioPicker scenario={scenario} />
      <Separator />
      <div>
        <div className="flex items-center justify-between"><p className="eyebrow">Wind bearing</p><Compass aria-hidden="true" className="size-4 text-lime-300" /></div>
        <div className="mt-4 flex items-end justify-between gap-4"><output className="font-display text-5xl leading-none tracking-[-0.05em]" htmlFor="wind-bearing">{bearing}°</output><p className="pb-1 text-xs text-muted-foreground">{bearingLabel(bearing)}</p></div>
        <input id="wind-bearing" className="range-control mt-6" aria-label="Wind bearing" type="range" min="0" max="359" value={bearing} onChange={(event) => onBearingChange(Number(event.currentTarget.value))} style={{ "--range-progress": `${bearing / 3.59}%` } as React.CSSProperties} />
        <div className="mt-2 flex justify-between text-[9px] font-semibold tracking-widest text-muted-foreground"><span>0° N</span><span>180° S</span><span>359° N</span></div>
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
          <Metric label="Turbines" value={record ? String(record.layout.count) : "—"} unit="V112" />
          <Metric label="Particles" value="64k" unit="live" />
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Speed and turbulence are inputs to the model, not readings taken at Askervein.</p>
      </div>
      <Separator />
      <div>
        <div className="flex items-center justify-between"><p className="eyebrow">Velocity</p><span className="text-[10px] text-muted-foreground">m/s</span></div>
        <div className="mt-4 h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${SPEED_STOPS.join(",")})` }} />
        <div className="mt-2 flex justify-between text-[10px] tabular-nums text-muted-foreground"><span>0</span><span>5</span><span>10</span><span>15+</span></div>
      </div>
      <Button className="mt-auto w-full" variant={reducedMotion ? "default" : "outline"} onClick={() => onReducedMotionChange(!reducedMotion)} aria-pressed={reducedMotion}><Pause aria-hidden="true" className="size-3.5" /> {reducedMotion ? "Resume particles" : "Pause particles"}</Button>
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

function SiteInfo({ onClose, onOpenAccuracy }: { onClose: () => void; onOpenAccuracy: () => void }) {
  return (
    <section className="site-info" aria-label="About this site">
      <div className="flex items-start justify-between gap-4">
        <div><p className="eyebrow text-lime-300">About this site</p><h2 className="mt-2 font-display text-xl">Why Askervein Hill?</h2></div>
        <Button size="icon" variant="ghost" className="-mr-2 -mt-2 size-8" onClick={onClose} aria-label="Close site information"><X className="size-4" /></Button>
      </div>
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
    </section>
  );
}

function ComfortPanel({ reducedMotion, onReducedMotionChange, onClose }: { reducedMotion: boolean; onReducedMotionChange: (reduced: boolean) => void; onClose: () => void }) {
  return <section className="site-info" aria-label="Viewer settings">
    <div className="flex items-start justify-between gap-4"><div><p className="eyebrow text-lime-300">Comfort</p><h2 className="mt-2 font-display text-xl">Viewer settings</h2></div><Button size="icon" variant="ghost" className="-mr-2 -mt-2 size-8" onClick={onClose} aria-label="Close viewer settings"><X className="size-4" /></Button></div>
    <label className="mt-5 flex cursor-pointer items-start justify-between gap-5"><span><span className="block text-sm font-semibold">Reduce particle motion</span><span className="mt-1 block text-xs leading-relaxed text-white/60">Freeze advection while keeping the field visible.</span></span><input aria-label="Reduce particle motion" type="checkbox" checked={reducedMotion} onChange={(event) => onReducedMotionChange(event.currentTarget.checked)} className="mt-1 size-4 accent-lime-300" /></label>
  </section>;
}

function TurbineInfo({ analysis, onClose }: { analysis: AnalysisState; onClose: () => void }) {
  const record = analysis.status === "ready" ? analysis.record : null;
  return (
    <section className="turbine-info" aria-label="Turbine information">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow text-lime-300">Demonstration layout</p>
          <h2 className="mt-2 font-display text-xl">{record ? `${record.layout.count} ${record.layout.turbine_name} turbines` : "Four V112 turbines"}</h2>
        </div>
        <Button size="icon" variant="ghost" className="-mr-2 -mt-2 size-8" onClick={onClose} aria-label="Close turbine information"><X className="size-4" /></Button>
      </div>
      {/* The terrain is real and the turbines are not. Rendered together they read as a
          wind farm, so the panel that names them has to say otherwise. */}
      <p className="mt-3 text-sm leading-relaxed text-white/70">No wind farm exists at Askervein. These turbines are placed for demonstration, and their figures describe that invented layout <ProvenanceTag provenance="computed" /> rather than the site.</p>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <Metric label="Rotor" value={record ? String(Math.round(record.layout.rotor_diameter_m)) : "112"} unit="m" />
        <Metric label="Hub" value="100" unit="m" />
        <Metric label="Farm loss" value={record ? percent(record.farm.farm_wake_loss_fraction, 0) : "—"} unit="" />
        <Metric label="Net" value={record ? kilowatts(record.farm.total_net_power_kw).replace(" kW", "") : "—"} unit="kW" />
      </dl>
    </section>
  );
}

function ScenePreview({ request, analysis, selectedId, onSelect, reducedMotion, onReducedMotionChange, provenance, scenario }: {
  request: unknown;
  analysis: AnalysisState;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  reducedMotion: boolean;
  onReducedMotionChange: (reduced: boolean) => void;
  provenance: ProvenanceState;
  scenario: Scenario;
}) {
  const [view, setView] = useState(INITIAL_VIEW);
  const [isDragging, setIsDragging] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [turbinesOpen, setTurbinesOpen] = useState(false);
  const [accuracyOpen, setAccuracyOpen] = useState(false);
  const [performanceOpen, setPerformanceOpen] = useState(true);
  const [taskOpen, setTaskOpen] = useState(() => !hasSeenPrimaryTask());
  const viewport = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; active: boolean; pointerId: number } | null>(null);

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
    else return;
    event.preventDefault();
    updateView(changes);
  };

  const record = analysis.status === "ready" ? analysis.record : null;
  const selected = record ? findTurbine(record, selectedId) : null;

  return (
    <section
      ref={viewport}
      className={isDragging ? "scene-preview is-dragging" : "scene-preview"}
      aria-label="Three-dimensional wind field viewport"
      aria-description="Use arrow keys to rotate. Use plus and minus to zoom. Select a turbine to see what the model says is waking it."
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    >
      <div className="scene-world" data-testid="scene-world">
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
            reducedMotion={reducedMotion}
            view={view}
            terrain={sceneTerrain(scenario.state.request)}
          />
        )}
      </div>
      <div className="absolute left-5 top-5 flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] backdrop-blur-md"><span className="size-1.5 rounded-full bg-lime-300 shadow-[0_0_12px_#bef264]" /> Desktop preview</div>
      <div className="absolute right-5 top-5 flex gap-2">
        <Button size="icon" variant="outline" onClick={() => setInfoOpen((open) => !open)} aria-label="About this site" aria-expanded={infoOpen}><Info className="size-4" /></Button>
        <Button size="icon" variant="outline" onClick={() => setView(INITIAL_VIEW)} aria-label="Reset view"><RotateCcw className="size-4" /></Button>
        <Button size="icon" variant="outline" onClick={() => setTurbinesOpen((open) => !open)} aria-label="Show turbine information" aria-expanded={turbinesOpen}><Layers3 className="size-4" /></Button><Button size="icon" variant="outline" onClick={() => setAccuracyOpen((open) => !open)} aria-label="Show model accuracy and limits" aria-expanded={accuracyOpen}><FlaskConical className="size-4" /></Button><Button size="icon" variant="outline" onClick={() => setSettingsOpen((open) => !open)} aria-label="Open viewer settings" aria-expanded={settingsOpen}><Settings2 className="size-4" /></Button>
      </div>
      {taskOpen ? <PrimaryTaskCard turbineCount={record?.layout.count ?? 4} bearingDeg={record?.wind.bearing_deg ?? 210} onDismiss={() => setTaskOpen(false)} /> : null}
      {infoOpen ? <SiteInfo onClose={() => setInfoOpen(false)} onOpenAccuracy={() => { setInfoOpen(false); setAccuracyOpen(true); }} /> : null}
      {settingsOpen ? <ComfortPanel reducedMotion={reducedMotion} onReducedMotionChange={onReducedMotionChange} onClose={() => setSettingsOpen(false)} /> : null}
      {turbinesOpen ? <TurbineInfo analysis={analysis} onClose={() => setTurbinesOpen(false)} /> : null}
      {accuracyOpen ? <ModelDisclosure state={provenance} onClose={() => setAccuracyOpen(false)} /> : null}
      {performanceOpen ? <div className="absolute bottom-24 right-5 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-white/60 backdrop-blur-md" role="status">60 FPS target · 16.7 ms budget</div> : null}
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
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
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
      <header className="flex h-[76px] items-center justify-between border-b border-border px-5 lg:px-8"><Brand /><nav className="flex items-center gap-1" aria-label="Primary navigation"><Button variant="outline" aria-label="Enter immersive view"><Move3d className="size-4" /><span className="hidden sm:inline">Enter immersive view</span></Button></nav></header>
      <div className="workspace-grid">
        <div className={panelOpen ? "mobile-panel is-open" : "mobile-panel"}>
          <AnalysisPanel
            scenario={scenario}
            reducedMotion={reducedMotion}
            onReducedMotionChange={setReducedMotion}
            analysis={analysis}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onClear={() => setSelectedId(null)}
          />
        </div>
        <ScenePreview request={request} analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} reducedMotion={reducedMotion} onReducedMotionChange={setReducedMotion} provenance={provenance} scenario={scenario} />
        <aside className="status-rail" aria-label="Performance status"><div className="flex items-center gap-2"><Gauge className="size-3.5 text-lime-300" /><span>Target 60 FPS</span></div><span className="text-muted-foreground">Desktop budget 16.7 ms</span><span className="text-muted-foreground">{provenance.status === "ready" ? `Model ${provenance.record.model_version}` : "Model version unavailable"}</span><span className="ml-auto text-muted-foreground">WebGL 2</span></aside>
      </div>
      <Button className="fixed bottom-5 left-5 z-50 lg:hidden" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}><Settings2 className="size-4" /> {panelOpen ? "Close controls" : "Field controls"}</Button>
    </main>
  );
}
