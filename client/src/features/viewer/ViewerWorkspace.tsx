import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { ChevronDown, Compass, Gauge, Info, Layers3, Move3d, Pause, RotateCcw, Settings2, Wind, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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

function AnalysisPanel({ bearing, onBearingChange, reducedMotion, onReducedMotionChange }: {
  bearing: number;
  onBearingChange: (bearing: number) => void;
  reducedMotion: boolean;
  onReducedMotionChange: (reduced: boolean) => void;
}) {
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
      <div>
        <div className="flex items-center justify-between"><p className="eyebrow">Wind bearing</p><Compass aria-hidden="true" className="size-4 text-lime-300" /></div>
        <div className="mt-4 flex items-end justify-between gap-4"><output className="font-display text-5xl leading-none tracking-[-0.05em]" htmlFor="wind-bearing">{bearing}°</output><p className="pb-1 text-xs text-muted-foreground">{bearingLabel(bearing)}</p></div>
        <input id="wind-bearing" className="range-control mt-6" aria-label="Wind bearing" type="range" min="0" max="359" value={bearing} onChange={(event) => onBearingChange(Number(event.currentTarget.value))} style={{ "--range-progress": `${bearing / 3.59}%` } as React.CSSProperties} />
        <div className="mt-2 flex justify-between text-[9px] font-semibold tracking-widest text-muted-foreground"><span>0° N</span><span>180° S</span><span>359° N</span></div>
      </div>
      <Separator />
      <div>
        <p className="eyebrow">Field conditions</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5"><Metric label="Mean speed" value="10.0" unit="m/s" /><Metric label="Turbulence" value="8.0" unit="%" /><Metric label="Particles" value="64k" unit="live" /><Metric label="Turbines" value="4" unit="V112" /></dl>
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

type ViewState = { yaw: number; pitch: number; zoom: number };

const INITIAL_VIEW: ViewState = { yaw: 0, pitch: 0, zoom: 1 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function SiteInfo({ onClose }: { onClose: () => void }) {
  return (
    <section className="site-info" aria-label="About this site">
      <div className="flex items-start justify-between gap-4">
        <div><p className="eyebrow text-lime-300">About this site</p><h2 className="mt-2 font-display text-xl">Why Askervein Hill?</h2></div>
        <Button size="icon" variant="ghost" className="-mr-2 -mt-2 size-8" onClick={onClose} aria-label="Close site information"><X className="size-4" /></Button>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-white/70">Published field measurements let us compare the model with observed wind over real terrain.</p>
      <Separator className="my-4" />
      <h3 className="text-sm font-semibold">Why one site?</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-white/70">One terrain dataset keeps the first accuracy and frame-time tests comparable. More sites come after this case is validated.</p>
      <h3 className="mt-4 text-sm font-semibold">Next</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-white/70">Compare the terrain-responsive field with published hilltop speed-up measurements.</p>
    </section>
  );
}

function ComfortPanel({ reducedMotion, onReducedMotionChange, onClose }: { reducedMotion: boolean; onReducedMotionChange: (reduced: boolean) => void; onClose: () => void }) {
  return <section className="site-info" aria-label="Viewer settings">
    <div className="flex items-start justify-between gap-4"><div><p className="eyebrow text-lime-300">Comfort</p><h2 className="mt-2 font-display text-xl">Viewer settings</h2></div><Button size="icon" variant="ghost" className="-mr-2 -mt-2 size-8" onClick={onClose} aria-label="Close viewer settings"><X className="size-4" /></Button></div>
    <label className="mt-5 flex cursor-pointer items-start justify-between gap-5"><span><span className="block text-sm font-semibold">Reduce particle motion</span><span className="mt-1 block text-xs leading-relaxed text-white/60">Freeze advection while keeping the field visible.</span></span><input aria-label="Reduce particle motion" type="checkbox" checked={reducedMotion} onChange={(event) => onReducedMotionChange(event.currentTarget.checked)} className="mt-1 size-4 accent-lime-300" /></label>
  </section>;
}

function TurbineInfo({ onClose }: { onClose: () => void }) {
  return <section className="turbine-info" aria-label="Turbine information"><div className="flex items-start justify-between gap-4"><div><p className="eyebrow text-lime-300">Farm layout</p><h2 className="mt-2 font-display text-xl">Four V112 turbines</h2></div><Button size="icon" variant="ghost" className="-mr-2 -mt-2 size-8" onClick={onClose} aria-label="Close turbine information"><X className="size-4" /></Button></div><dl className="mt-4 grid grid-cols-2 gap-4"><Metric label="Rotor" value="112" unit="m" /><Metric label="Hub" value="100" unit="m" /><Metric label="Rows" value="2" unit="" /><Metric label="Columns" value="2" unit="" /></dl></section>;
}

function ScenePreview({ bearing, reducedMotion, onReducedMotionChange }: { bearing: number; reducedMotion: boolean; onReducedMotionChange: (reduced: boolean) => void }) {
  const [view, setView] = useState(INITIAL_VIEW);
  const [isDragging, setIsDragging] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [turbinesOpen, setTurbinesOpen] = useState(false);
  const [performanceOpen, setPerformanceOpen] = useState(true);
  const viewport = useRef<HTMLElement>(null);
  const dragOrigin = useRef({ x: 0, y: 0 });

  const updateView = (changes: Partial<ViewState>) => {
    setView((current) => ({ ...current, ...changes }));
  };

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button, input, label, a")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = { x: event.clientX, y: event.clientY };
    setIsDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!isDragging) return;
    const dx = event.clientX - dragOrigin.current.x;
    const dy = event.clientY - dragOrigin.current.y;
    dragOrigin.current = { x: event.clientX, y: event.clientY };
    setView((current) => ({
      ...current,
      yaw: current.yaw + dx * 0.08,
      pitch: clamp(current.pitch - dy * 0.05, -5, 5),
    }));
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

  return (
    <section
      ref={viewport}
      className={isDragging ? "scene-preview is-dragging" : "scene-preview"}
      aria-label="Three-dimensional wind field viewport"
      aria-description="Use arrow keys to rotate. Use plus and minus to zoom."
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={() => setIsDragging(false)}
      onPointerCancel={() => setIsDragging(false)}
      onKeyDown={handleKeyDown}
    >
      <div className="scene-world" data-testid="scene-world">
        <SpatialFieldViewport view={view} bearingDeg={bearing} reducedMotion={reducedMotion} />
      </div>
      <div className="absolute left-5 top-5 flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] backdrop-blur-md"><span className="size-1.5 rounded-full bg-lime-300 shadow-[0_0_12px_#bef264]" /> Desktop preview</div>
      <div className="absolute right-5 top-5 flex gap-2">
        <Button size="icon" variant="outline" onClick={() => setInfoOpen((open) => !open)} aria-label="About this site" aria-expanded={infoOpen}><Info className="size-4" /></Button>
        <Button size="icon" variant="outline" onClick={() => setView(INITIAL_VIEW)} aria-label="Reset view"><RotateCcw className="size-4" /></Button>
        <Button size="icon" variant="outline" onClick={() => setTurbinesOpen((open) => !open)} aria-label="Show turbine information" aria-expanded={turbinesOpen}><Layers3 className="size-4" /></Button><Button size="icon" variant="outline" onClick={() => setSettingsOpen((open) => !open)} aria-label="Open viewer settings" aria-expanded={settingsOpen}><Settings2 className="size-4" /></Button>
      </div>
      {infoOpen ? <SiteInfo onClose={() => setInfoOpen(false)} /> : null}
      {settingsOpen ? <ComfortPanel reducedMotion={reducedMotion} onReducedMotionChange={onReducedMotionChange} onClose={() => setSettingsOpen(false)} /> : null}
      {turbinesOpen ? <TurbineInfo onClose={() => setTurbinesOpen(false)} /> : null}
      {performanceOpen ? <div className="absolute bottom-24 right-5 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-white/60 backdrop-blur-md" role="status">60 FPS target · 16.7 ms budget</div> : null}
      <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between gap-4">
        <div className="max-w-sm rounded-2xl border border-white/10 bg-black/30 p-4 backdrop-blur-md"><p className="eyebrow text-lime-300">Live field</p><p className="mt-2 text-sm leading-relaxed text-white/70">GPU-advected particles show the computed three-dimensional velocity field.</p></div>
        <button type="button" onClick={() => setPerformanceOpen((open) => !open)} aria-expanded={performanceOpen} className="hidden rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[10px] text-white/60 backdrop-blur-md sm:block">{performanceOpen ? "Hide performance" : "Show performance"}</button>
      </div>
    </section>
  );
}

export function ViewerWorkspace() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [bearing, setBearing] = useState(210);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex h-[76px] items-center justify-between border-b border-border px-5 lg:px-8"><Brand /><nav className="flex items-center gap-1" aria-label="Primary navigation"><Button variant="outline" aria-label="Enter immersive view"><Move3d className="size-4" /><span className="hidden sm:inline">Enter immersive view</span></Button></nav></header>
      <div className="workspace-grid">
        <div className={panelOpen ? "mobile-panel is-open" : "mobile-panel"}><AnalysisPanel bearing={bearing} onBearingChange={setBearing} reducedMotion={reducedMotion} onReducedMotionChange={setReducedMotion} /></div>
        <ScenePreview bearing={bearing} reducedMotion={reducedMotion} onReducedMotionChange={setReducedMotion} />
        <aside className="status-rail" aria-label="Performance status"><div className="flex items-center gap-2"><Gauge className="size-3.5 text-lime-300" /><span>Target 60 FPS</span></div><span className="text-muted-foreground">Desktop budget 16.7 ms</span><span className="ml-auto text-muted-foreground">WebGL 2</span></aside>
      </div>
      <Button className="fixed bottom-5 left-5 z-50 lg:hidden" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}><Settings2 className="size-4" /> {panelOpen ? "Close controls" : "Field controls"}</Button>
    </main>
  );
}
