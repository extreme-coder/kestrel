import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { ChevronDown, Compass, Gauge, Info, Layers3, Move3d, Play, RotateCcw, Settings2, Wind, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

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

function AnalysisPanel() {
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
        <div className="mt-4 flex items-end justify-between gap-4"><p className="font-display text-5xl leading-none tracking-[-0.05em]">210°</p><p className="pb-1 text-xs text-muted-foreground">South-west</p></div>
        <input className="range-control mt-6" aria-label="Wind bearing" type="range" min="0" max="359" defaultValue="210" />
        <div className="mt-2 flex justify-between text-[9px] font-semibold tracking-widest text-muted-foreground"><span>0° N</span><span>180° S</span><span>359° N</span></div>
      </div>
      <Separator />
      <div>
        <p className="eyebrow">Field conditions</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5"><Metric label="Mean speed" value="10.0" unit="m/s" /><Metric label="Turbulence" value="8.0" unit="%" /><Metric label="Particles" value="64k" unit="live" /><Metric label="Turbines" value="12" unit="V112" /></dl>
      </div>
      <Separator />
      <div>
        <div className="flex items-center justify-between"><p className="eyebrow">Velocity</p><span className="text-[10px] text-muted-foreground">m/s</span></div>
        <div className="mt-4 h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${SPEED_STOPS.join(",")})` }} />
        <div className="mt-2 flex justify-between text-[10px] tabular-nums text-muted-foreground"><span>0</span><span>5</span><span>10</span><span>15+</span></div>
      </div>
      <Button className="mt-auto w-full"><Play aria-hidden="true" className="size-3.5 fill-current" /> Run field</Button>
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
      <p className="mt-1.5 text-sm leading-relaxed text-white/70">Load the measured terrain, render the server velocity field, and test it against the published measurements.</p>
    </section>
  );
}

function ScenePreview() {
  const [view, setView] = useState(INITIAL_VIEW);
  const [isDragging, setIsDragging] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const dragOrigin = useRef({ x: 0, y: 0 });

  const updateView = (changes: Partial<ViewState>) => {
    setView((current) => ({ ...current, ...changes }));
  };

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
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

  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    event.preventDefault();
    setView((current) => ({ ...current, zoom: clamp(current.zoom - event.deltaY * 0.001, 0.78, 1.35) }));
  };

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
      className={isDragging ? "scene-preview is-dragging" : "scene-preview"}
      aria-label="Three-dimensional wind field viewport"
      aria-description="Use arrow keys to rotate. Use plus and minus to zoom."
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={() => setIsDragging(false)}
      onPointerCancel={() => setIsDragging(false)}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
    >
      <div className="scene-world" data-testid="scene-world" style={{ "--yaw": `${view.yaw}deg`, "--pitch": `${view.pitch}px`, "--zoom": view.zoom } as CSSProperties}>
        <div className="terrain-grid" aria-hidden="true" /><div className="hill hill-back" aria-hidden="true" /><div className="hill hill-front" aria-hidden="true" />
        <div className="flow-lines" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ "--i": index } as CSSProperties} />)}</div>
        <div className="turbine t-one" aria-hidden="true"><i /><b /></div><div className="turbine t-two" aria-hidden="true"><i /><b /></div><div className="turbine t-three" aria-hidden="true"><i /><b /></div>
      </div>
      <div className="absolute left-5 top-5 flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] backdrop-blur-md"><span className="size-1.5 rounded-full bg-lime-300 shadow-[0_0_12px_#bef264]" /> Desktop preview</div>
      <div className="absolute right-5 top-5 flex gap-2">
        <Button size="icon" variant="outline" onClick={() => setInfoOpen((open) => !open)} aria-label="About this site" aria-expanded={infoOpen}><Info className="size-4" /></Button>
        <Button size="icon" variant="outline" onClick={() => setView(INITIAL_VIEW)} aria-label="Reset view"><RotateCcw className="size-4" /></Button>
        <Button size="icon" variant="outline" aria-label="Change scene layers"><Layers3 className="size-4" /></Button><Button size="icon" variant="outline" aria-label="Open viewer settings"><Settings2 className="size-4" /></Button>
      </div>
      {infoOpen ? <SiteInfo onClose={() => setInfoOpen(false)} /> : null}
      <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between gap-4">
        <div className="max-w-sm rounded-2xl border border-white/10 bg-black/30 p-4 backdrop-blur-md"><p className="eyebrow text-lime-300">Field preview</p><p className="mt-2 text-sm leading-relaxed text-white/70">The live terrain and velocity field are the next build step.</p></div>
        <div className="hidden rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[10px] text-white/60 backdrop-blur-md sm:block">Drag to rotate · Scroll to zoom</div>
      </div>
    </section>
  );
}

export function ViewerWorkspace() {
  const [panelOpen, setPanelOpen] = useState(false);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex h-[76px] items-center justify-between border-b border-border px-5 lg:px-8"><Brand /><nav className="flex items-center gap-1" aria-label="Primary navigation"><Button variant="outline" aria-label="Enter immersive view"><Move3d className="size-4" /><span className="hidden sm:inline">Enter immersive view</span></Button></nav></header>
      <div className="workspace-grid">
        <div className={panelOpen ? "mobile-panel is-open" : "mobile-panel"}><AnalysisPanel /></div>
        <ScenePreview />
        <aside className="status-rail" aria-label="Performance status"><div className="flex items-center gap-2"><Gauge className="size-3.5 text-lime-300" /><span>60 FPS</span></div><span className="text-muted-foreground">Frame 8.4 ms</span><span className="ml-auto text-muted-foreground">WebGL 2</span></aside>
      </div>
      <Button className="fixed bottom-5 left-5 z-50 lg:hidden" onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen}><Settings2 className="size-4" /> {panelOpen ? "Close controls" : "Field controls"}</Button>
    </main>
  );
}
