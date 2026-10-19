import type { Integrations, Settings } from "../api";
import type { UpdateSettings } from "../App";
import { cx } from "./classNames";

interface PluginsStepProps {
  settings: Settings;
  updateSettings: UpdateSettings;
}

const PLUGINS: { key: keyof Integrations; letter: string; name: string; description: string }[] = [
  { key: "github", letter: "G", name: "GitHub", description: "Repository access and pull requests" },
  { key: "terminal", letter: "T", name: "Terminal", description: "Let the agent run shell commands without asking" },
  { key: "figma", letter: "F", name: "Figma", description: "Access design context and assets" },
  { key: "browser", letter: "B", name: "Browser", description: "Inspect and test local applications" },
];

export default function PluginsStep({ settings, updateSettings }: PluginsStepProps) {
  const toggle = (key: keyof Integrations) =>
    void updateSettings((s) => ({
      ...s,
      integrations: { ...s.integrations, [key]: !s.integrations[key] },
    }));

  return (
    <>
      <div className="ob-card-title">Optional integrations</div>
      <div className="ob-option-list">
        {PLUGINS.map((p) => {
          const on = settings.integrations[p.key];
          // The whole row toggles. The switch inside has no handler of its own, so
          // its click (or keyboard activation) bubbles up to the row exactly once.
          return (
            <div
              key={p.key}
              className={cx("ob-option is-clickable", on && "is-selected")}
              onClick={() => toggle(p.key)}
            >
              <span className="ob-tile">{p.letter}</span>
              <span className="ob-option-text">
                <span className="ob-option-name">{p.name}</span>
                <span className="ob-option-detail">{p.description}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${p.name} integration`}
                className="toggle"
              />
            </div>
          );
        })}
      </div>
      <p className="ob-card-note">You can change integration permissions in Settings.</p>
    </>
  );
}
