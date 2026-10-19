import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CaretDownIcon, MagnifyingGlassIcon, StarIcon } from "@phosphor-icons/react";
import { AGENT_LABELS, type AgentKind, type ModelOption } from "~/api";
import ProviderLogos from "~/components/ProviderLogos";

interface Props {
  agent: AgentKind;
  model: string | null;
  agents: AgentKind[];
  models: Partial<Record<AgentKind, ModelOption[]>>;
  onPick: (agent: AgentKind, model: string | null) => void;
}
const PROVIDER_NAMES: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
const favoriteKey = "patchwork-model-favorites";
/** Favorites saved before model ids came from the model manifest used CLI aliases. */
const LEGACY_FAVORITES: Record<string, string> = {
  "claude:fable": "claude:claude-fable-5-1",
  "claude:opus": "claude:claude-opus-5-5",
  "claude:sonnet": "claude:claude-sonnet-5-5",
  "claude:haiku": "claude:claude-haiku-5-5",
  "gemini:pro": "gemini:gemini-3.1-pro-preview",
  "gemini:flash": "gemini:gemini-3.8-flash",
  "gemini:flash-lite": "gemini:gemini-3.5-flash-lite",
};
function readFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(favoriteKey) ?? "[]");
    if (!Array.isArray(value)) return [];
    const keys = value.filter((v): v is string => typeof v === "string").map((k) => LEGACY_FAVORITES[k] ?? k);
    return [...new Set(keys)];
  } catch { return []; }
}

export default function ModelPicker(props: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = props.models[props.agent]?.find((m) => m.id === props.model)?.label ?? props.model ?? "Default";
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={trigger} className="ws-chip-btn" aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Choose model: ${label}`} onClick={() => setOpen(!open)}>
      <ProviderLogos kind={props.agent} size={14} /><span>{label}</span><CaretDownIcon size={12} />
    </button>
    {open && createPortal(<PickerPopup {...props} anchor={trigger.current!} close={close} />, document.body)}
  </>;
}

function PickerPopup({ agent, model, agents, models, onPick, anchor, close }: Props & { anchor: HTMLButtonElement; close: () => void }) {
  const [favorites, setFavorites] = useState(readFavorites);
  // Open on Favorites only if a favorite is still in the model list.
  const [provider, setProvider] = useState<AgentKind | "favorites">(() => {
    const hasFavorite = agents.some((kind) => (models[kind] ?? []).some((m) => favorites.includes(`${kind}:${m.id ?? "default"}`)));
    return agents.length > 1 && hasFavorite ? "favorites" : agent;
  });
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;
  const rows = agents.flatMap((kind) => (models[kind] ?? []).map((item) => ({ kind, item, key: `${kind}:${item.id ?? "default"}` })))
    .filter(({ kind, item, key }) => searching
      ? `${item.label} ${item.defaultModel ?? ""} ${AGENT_LABELS[kind]}`.toLowerCase().includes(query.trim().toLowerCase())
      : provider === "favorites" ? favorites.includes(key) : provider === kind)
    .sort((a, b) => Number(favorites.includes(b.key)) - Number(favorites.includes(a.key)));
  const rowsKey = rows.map((row) => row.key).join("|");

  useLayoutEffect(() => {
    const position = () => {
      if (!panel.current) return;
      const rect = anchor.getBoundingClientRect();
      const above = rect.top - 12;
      const below = window.innerHeight - rect.bottom - 12;
      const up = above >= 346 || above >= below;
      Object.assign(panel.current.style, {
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 368))}px`,
        top: up ? "auto" : `${rect.bottom + 4}px`,
        bottom: up ? `${window.innerHeight - rect.top + 4}px` : "auto",
        maxHeight: `${Math.max(0, Math.min(346, up ? above : below))}px`,
      });
    };
    position();
    input.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [anchor]);

  useLayoutEffect(() => { setHighlight(0); if (list.current) list.current.scrollTop = 0; }, [rowsKey]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target)) close();
    };
    const wheel = (event: WheelEvent | TouchEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) event.preventDefault();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("touchmove", wheel, { passive: false });
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("wheel", wheel); document.removeEventListener("touchmove", wheel); };
  }, [anchor, close]);

  const choose = (index: number) => { const row = rows[index]; if (row) { onPick(row.kind, row.item.id); close(); } };
  const selectProvider = (next: AgentKind | "favorites") => { setProvider(next); input.current?.focus({ preventScroll: true }); };
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) { event.preventDefault(); choose(Number(event.key) - 1); }
    else if (event.target === input.current && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const next = rows.length ? (highlight + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : 0;
      setHighlight(next);
      list.current?.querySelectorAll(".ws-model-row")[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.target === input.current && event.key === "Enter") { event.preventDefault(); choose(highlight); }
    else if (event.target === input.current && !searching && (event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey))) {
      event.preventDefault(); panel.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    }
  };
  return <div ref={panel} className="ws-model-popup" role="dialog" aria-label="Choose model" onKeyDown={keyDown}>
    {!searching && <nav className="ws-model-rail" aria-label="Providers" onKeyDown={(event) => {
      const filters: (AgentKind | "favorites")[] = ["favorites", ...agents];
      if (event.key === "ArrowRight") { event.preventDefault(); input.current?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); const next = (filters.indexOf(provider) + (event.key === "ArrowDown" ? 1 : -1) + filters.length) % filters.length;
        setProvider(filters[next]); panel.current?.querySelectorAll<HTMLButtonElement>(".ws-model-rail-btn")[next]?.focus();
      }
    }}>
      <button className="ws-model-rail-btn" aria-label="Favorites" title="Favorites" aria-pressed={provider === "favorites"} onClick={() => selectProvider("favorites")}><StarIcon size={20} weight="fill" /></button>
      <span className="ws-model-rail-divider" />
      {agents.map((kind) => <button key={kind} className="ws-model-rail-btn" title={AGENT_LABELS[kind]} aria-label={AGENT_LABELS[kind]} aria-pressed={provider === kind} onClick={() => selectProvider(kind)}><ProviderLogos kind={kind} size={20} /></button>)}
    </nav>}
    <div className="ws-model-content">
      <label className="ws-model-search"><MagnifyingGlassIcon size={16} /><input ref={input} role="combobox" aria-expanded="true" aria-controls="ws-model-options" aria-activedescendant={rows[highlight] ? `ws-model-option-${highlight}` : undefined}
        value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models..." aria-label="Search models" /></label>
      <div ref={list} id="ws-model-options" className="ws-model-results" role="listbox" aria-label="Models">
        {rows.map(({ kind, item, key }, index) => <div key={key} id={`ws-model-option-${index}`} role="option" aria-selected={kind === agent && item.id === model}
          className={`ws-model-row${highlight === index ? " highlighted" : ""}`} onMouseMove={() => setHighlight(index)} onClick={() => choose(index)}>
          <span className="ws-model-row-copy"><span className="ws-model-row-name">{item.label}</span><span className="ws-model-row-provider" title={item.id === null ? "Configured CLI default; session or project settings may override it" : undefined}><ProviderLogos kind={kind} size={12} /><span className="ws-model-row-subtitle">{item.id === null ? item.defaultModel ?? "CLI default — unresolved" : PROVIDER_NAMES[kind]}</span></span></span>
          {index < 9 && <kbd>{navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+{index + 1}</kbd>}
          <button className={`ws-model-star${favorites.includes(key) ? " favorited" : ""}`} aria-label={favorites.includes(key) ? `Remove ${item.label} from favorites` : `Add ${item.label} to favorites`}
            onKeyDown={(event) => event.stopPropagation()} onClick={(event) => {
              event.stopPropagation(); const next = favorites.includes(key) ? favorites.filter((value) => value !== key) : [...favorites, key];
              setFavorites(next); try { localStorage.setItem(favoriteKey, JSON.stringify(next)); } catch { /* Favorites still work for this session. */ }
            }}><StarIcon size={12} fill={favorites.includes(key) ? "currentColor" : "none"} /></button>
        </div>)}
        {!rows.length && <div className="ws-model-empty">No models found</div>}
      </div>
    </div>
  </div>;
}
