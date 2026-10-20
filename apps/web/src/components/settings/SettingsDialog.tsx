import { useCallback, useEffect, useState } from "react";
import {
  DownloadSimpleIcon,
  FolderSimpleIcon,
  GitPullRequestIcon,
  GlobeIcon,
  PaintBrushIcon,
  PaletteIcon,
  PlugIcon,
  RobotIcon,
  TerminalWindowIcon,
  TrashIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import {
  api,
  AGENT_LABELS,
  importSourcesFor,
  SOURCE_LABELS,
  type AgentKind,
  type AgentStatus,
  type ImportScan,
  type ImportSource,
  type Integrations,
  type Settings,
  type Theme,
} from "~/api";
import ProviderLogos from "~/components/ProviderLogos";
import type { UpdateSettings } from "~/app/App";
import { syncProjects } from "~/lib/projects";
import { AGENT_KINDS, describeAgent, errorText } from "~/lib/util";

type Section = "appearance" | "agent" | "imports" | "integrations" | "projects";

const SECTIONS: { id: Section; label: string; Icon: Icon }[] = [
  { id: "appearance", label: "Appearance", Icon: PaletteIcon },
  { id: "agent", label: "Providers", Icon: RobotIcon },
  { id: "imports", label: "Imports", Icon: DownloadSimpleIcon },
  { id: "integrations", label: "Integrations", Icon: PlugIcon },
  { id: "projects", label: "Projects", Icon: FolderSimpleIcon },
];

interface PaneProps {
  settings: Settings;
  updateSettings: UpdateSettings;
}

interface SettingsDialogProps extends PaneProps {
  /** Called after conversations were imported, so threads can be reloaded. */
  onImported: () => void;
  onClose: () => void;
}

export default function SettingsDialog({
  settings,
  updateSettings,
  onImported,
  onClose,
}: SettingsDialogProps) {
  const [section, setSection] = useState<Section>("appearance");
  const title = SECTIONS.find((s) => s.id === section)?.label ?? "";
  const paneProps = { settings, updateSettings };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(0,0,0,0.4)]"
      onMouseDown={onClose}
    >
      <div
        className="flex h-[460px] max-h-[calc(100vh_-_48px)] w-[640px] max-w-[calc(100vw_-_48px)] overflow-hidden rounded-[var(--radius-lg)] border border-border-strong bg-elevated shadow-[var(--shadow-popup)]"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="flex w-[180px] flex-none flex-col gap-0.5 border-r border-border bg-panel px-2 py-2.5">
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`flex h-7 cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border-none bg-transparent px-2 text-left text-fg ${section === id ? "bg-selected" : "hover:bg-hover"}`}
              onClick={() => setSection(id)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 flex-none items-center justify-between pr-4 pl-5">
            <h2 className="m-0 text-[length:var(--fs-lg)] font-semibold">{title}</h2>
            <button className="btn-icon" title="Close" aria-label="Close" onClick={onClose}>
              <XIcon size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            {section === "appearance" && <AppearancePane {...paneProps} />}
            {section === "agent" && <AgentPane {...paneProps} />}
            {section === "imports" && <ImportsPane {...paneProps} onImported={onImported} />}
            {section === "integrations" && <IntegrationsPane {...paneProps} />}
            {section === "projects" && <ProjectsPane {...paneProps} />}
          </div>
        </div>
      </div>
    </div>
  );
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function AppearancePane({ settings, updateSettings }: PaneProps) {
  return (
    <div className="flex items-center gap-3 border-b border-border py-2.5">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Theme</div>
        <div className="text-[length:var(--fs-sm)] text-fg-muted">
          Light, dark, or follow the system setting
        </div>
      </div>
      <div className="inline-flex overflow-hidden rounded-[var(--radius-sm)] border border-border-strong">
        {THEMES.map((t) => (
          <button
            key={t.value}
            className={`grid h-6 w-auto cursor-pointer place-items-center border-none px-2.5 py-0 text-[length:var(--fs-sm)] [&+&]:border-l [&+&]:border-border-strong ${settings.theme === t.value ? "bg-selected text-fg" : "bg-transparent text-fg-muted hover:bg-hover hover:text-fg"}`}
            onClick={() => void updateSettings((s) => ({ ...s, theme: t.value }))}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentPane({ settings, updateSettings }: PaneProps) {
  const [status, setStatus] = useState<Partial<Record<AgentKind, AgentStatus | null>>>({});

  useEffect(() => {
    let cancelled = false;
    for (const kind of AGENT_KINDS) {
      api.detectAgent(kind).then(
        (s) => {
          if (!cancelled) setStatus((prev) => ({ ...prev, [kind]: s }));
        },
        () => {
          if (!cancelled) setStatus((prev) => ({ ...prev, [kind]: null }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = settings.agents;
  const toggle = (kind: AgentKind) =>
    void updateSettings((st) => ({
      ...st,
      agents: st.agents.includes(kind) ? st.agents.filter((k) => k !== kind) : [...st.agents, kind],
    }));
  const makeDefault = (kind: AgentKind) =>
    void updateSettings((st) => ({
      ...st,
      agents: [kind, ...st.agents.filter((k) => k !== kind)],
    }));

  return (
    <>
      {AGENT_KINDS.map((kind) => {
        const s = status[kind];
        const on = connected.includes(kind);
        const badge = s === undefined ? "Checking…" : s?.installed ? "Installed" : "Not installed";
        // Keep at least one agent connected, and only connect installed ones.
        const locked = on ? connected.length === 1 : !s?.installed;
        return (
          <div key={kind} className="flex items-center gap-3 border-b border-border py-2.5">
            <ProviderLogos kind={kind} size={20} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{AGENT_LABELS[kind]}</div>
              <div className="text-[length:var(--fs-sm)] text-fg-muted">{describeAgent(s)}</div>
            </div>
            <span className={`badge${s?.installed ? " badge-success" : ""}`}>{badge}</span>
            <button
              className="toggle"
              role="switch"
              aria-label={`Connect ${AGENT_LABELS[kind]}`}
              aria-checked={on}
              disabled={locked}
              onClick={() => toggle(kind)}
            />
          </div>
        );
      })}
      {connected.length > 1 && (
        <div className="flex items-center gap-3 border-b border-border py-2.5">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Default for new tasks</div>
            <div className="text-[length:var(--fs-sm)] text-fg-muted">
              You can still pick an agent per task in the composer
            </div>
          </div>
          <div className="inline-flex overflow-hidden rounded-[var(--radius-sm)] border border-border-strong">
            {/* Fixed order: choosing a default reorders `agents`, not the buttons. */}
            {AGENT_KINDS.filter((kind) => connected.includes(kind)).map((kind) => (
              <button
                key={kind}
                className={`grid h-6 w-auto cursor-pointer place-items-center border-none px-2.5 py-0 text-[length:var(--fs-sm)] [&+&]:border-l [&+&]:border-border-strong ${connected[0] === kind ? "bg-selected text-fg" : "bg-transparent text-fg-muted hover:bg-hover hover:text-fg"}`}
                onClick={() => makeDefault(kind)}
              >
                {AGENT_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function ImportsPane({
  settings,
  updateSettings,
  onImported,
}: PaneProps & { onImported: () => void }) {
  const [scans, setScans] = useState<Partial<Record<ImportSource, ImportScan | null>>>({});
  const [busy, setBusy] = useState<ImportSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sources = importSourcesFor(AGENT_KINDS.filter((k) => settings.agents.includes(k)));
  const key = sources.join(",");

  const scan = useCallback((kind: ImportSource) => {
    api.scanImports(kind).then(
      (s) => setScans((prev) => ({ ...prev, [kind]: s })),
      () => setScans((prev) => ({ ...prev, [kind]: null })),
    );
  }, []);

  // `key` stands in for `sources`, which is a new array on every render.
  useEffect(() => {
    for (const kind of sources) scan(kind);
  }, [key, scan]);

  const importFrom = async (kind: ImportSource) => {
    setBusy(kind);
    setError(null);
    try {
      await api.importThreads([kind]);
      // Importing adds projects on the backend; pick them up before saving settings again.
      await updateSettings(await api.getSettings());
      onImported();
      scan(kind);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {sources.map((kind) => {
        const s = scans[kind];
        // T3 Code is only offered to people who use it.
        if (kind === "t3" && !(s && s.found > 0)) return null;
        const desc =
          s === undefined
            ? "Looking for saved conversations…"
            : s === null
              ? "Couldn't read saved conversations"
              : s.new > 0
                ? `${s.new} of ${s.found} conversations not imported yet`
                : s.found > 0
                  ? `All ${s.found} conversations imported`
                  : "No saved conversations";
        return (
          <div key={kind} className="flex items-center gap-3 border-b border-border py-2.5">
            <ProviderLogos kind={kind} size={20} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{SOURCE_LABELS[kind]}</div>
              <div className="text-[length:var(--fs-sm)] text-fg-muted">{desc}</div>
              {s && s.subagents > 0 && (
                <div className="text-[length:var(--fs-sm)] text-fg-muted">
                  {s.subagents} sub-agent {s.subagents === 1 ? "conversation" : "conversations"}{" "}
                  hidden
                </div>
              )}
            </div>
            <button
              className="btn"
              disabled={busy !== null || !s || s.new === 0}
              onClick={() => void importFrom(kind)}
            >
              {busy === kind ? "Importing…" : "Import"}
            </button>
          </div>
        );
      })}
      {error && <div className="text-[length:var(--fs-sm)] text-danger">{error}</div>}
    </>
  );
}

const INTEGRATIONS: { key: keyof Integrations; label: string; desc: string; Icon: Icon }[] = [
  {
    key: "github",
    label: "GitHub",
    desc: "Read repositories and pull requests",
    Icon: GitPullRequestIcon,
  },
  {
    key: "terminal",
    label: "Terminal",
    desc: "Let the agent run shell commands without asking",
    Icon: TerminalWindowIcon,
  },
  { key: "figma", label: "Figma", desc: "Read designs from Figma files", Icon: PaintBrushIcon },
  {
    key: "browser",
    label: "Browser",
    desc: "Let the agent open pages in a browser",
    Icon: GlobeIcon,
  },
];

function IntegrationsPane({ settings, updateSettings }: PaneProps) {
  return (
    <>
      {INTEGRATIONS.map(({ key, label, desc, Icon }) => (
        <div key={key} className="flex items-center gap-3 border-b border-border py-2.5">
          <Icon size={16} className="text-fg-subtle" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{label}</div>
            <div className="text-[length:var(--fs-sm)] text-fg-muted">{desc}</div>
          </div>
          <button
            className="toggle"
            role="switch"
            aria-label={label}
            aria-checked={settings.integrations[key]}
            onClick={() =>
              void updateSettings((s) => ({
                ...s,
                integrations: { ...s.integrations, [key]: !s.integrations[key] },
              }))
            }
          />
        </div>
      ))}
    </>
  );
}

function ProjectsPane({ settings, updateSettings }: PaneProps) {
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string) {
    setError(null);
    try {
      await api.removeProject(id);
      await syncProjects(updateSettings);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <>
      {settings.projects.length === 0 && (
        <div className="px-3 py-2 text-[length:var(--fs-sm)] text-fg-subtle">No projects yet</div>
      )}
      {settings.projects.map((p) => (
        <div key={p.id} className="flex items-center gap-2 border-b border-border py-2">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{p.name}</div>
            <div className="overflow-hidden text-ellipsis whitespace-nowrap font-[family-name:var(--font-mono)] text-[length:var(--fs-xs)] text-fg-muted">
              {p.path}
            </div>
          </div>
          <button
            className="btn-icon"
            title="Remove project"
            aria-label="Remove project"
            onClick={() => void remove(p.id)}
          >
            <TrashIcon size={14} />
          </button>
        </div>
      ))}
      {error && <div className="mt-2 text-[length:var(--fs-sm)] text-danger">{error}</div>}
      <div className="mt-4">
        <button
          className="btn"
          onClick={() => void updateSettings((s) => ({ ...s, onboarded: false }))}
        >
          Run setup again
        </button>
      </div>
    </>
  );
}
