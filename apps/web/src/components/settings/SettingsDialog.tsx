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
    <div className="ws-overlay" onMouseDown={onClose}>
      <div
        className="ws-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="ws-dialog-nav">
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`ws-dialog-nav-item${section === id ? " active" : ""}`}
              onClick={() => setSection(id)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className="ws-dialog-body">
          <div className="ws-dialog-head">
            <h2>{title}</h2>
            <button className="btn-icon" title="Close" aria-label="Close" onClick={onClose}>
              <XIcon size={16} />
            </button>
          </div>
          <div className="ws-dialog-section">
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
    <div className="ws-setting-row">
      <div className="ws-setting-text">
        <div className="ws-setting-title">Theme</div>
        <div className="ws-setting-desc">Light, dark, or follow the system setting</div>
      </div>
      <div className="ws-segmented">
        {THEMES.map((t) => (
          <button
            key={t.value}
            className={`ws-seg ws-seg-text${settings.theme === t.value ? " active" : ""}`}
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
          <div key={kind} className="ws-setting-row">
            <ProviderLogos kind={kind} size={20} />
            <div className="ws-setting-text">
              <div className="ws-setting-title">{AGENT_LABELS[kind]}</div>
              <div className="ws-setting-desc">{describeAgent(s)}</div>
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
        <div className="ws-setting-row">
          <div className="ws-setting-text">
            <div className="ws-setting-title">Default for new tasks</div>
            <div className="ws-setting-desc">
              You can still pick an agent per task in the composer
            </div>
          </div>
          <div className="ws-segmented">
            {/* Fixed order: choosing a default reorders `agents`, not the buttons. */}
            {AGENT_KINDS.filter((kind) => connected.includes(kind)).map((kind) => (
              <button
                key={kind}
                className={`ws-seg ws-seg-text${connected[0] === kind ? " active" : ""}`}
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
          <div key={kind} className="ws-setting-row">
            <ProviderLogos kind={kind} size={20} />
            <div className="ws-setting-text">
              <div className="ws-setting-title">{SOURCE_LABELS[kind]}</div>
              <div className="ws-setting-desc">{desc}</div>
              {s && s.subagents > 0 && (
                <div className="ws-setting-desc">
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
      {error && <div className="ws-setting-desc ws-setting-error">{error}</div>}
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
        <div key={key} className="ws-setting-row">
          <Icon size={16} className="ws-icon-muted" />
          <div className="ws-setting-text">
            <div className="ws-setting-title">{label}</div>
            <div className="ws-setting-desc">{desc}</div>
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
      {settings.projects.length === 0 && <div className="ws-muted-note">No projects yet</div>}
      {settings.projects.map((p) => (
        <div key={p.id} className="ws-project-row">
          <div className="ws-project-info">
            <div className="ws-project-title">{p.name}</div>
            <div className="ws-project-path">{p.path}</div>
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
      {error && <div className="ws-error-text">{error}</div>}
      <div className="ws-setup">
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
