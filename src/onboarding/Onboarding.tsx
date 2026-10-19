import { useEffect, useState } from "react";
import { ArrowRight, Moon, Sun } from "lucide-react";
import type { AgentKind, Settings } from "../api";
import type { UpdateSettings } from "../App";
import AgentStep from "./AgentStep";
import DevicesStep from "./DevicesStep";
import PluginsStep from "./PluginsStep";
import ProjectsStep from "./ProjectsStep";
import Stepper from "./Stepper";
import { AGENT_KINDS, isReady, useAgentProbes } from "./agentProbes";
import "./Onboarding.css";

export interface OnboardingProps {
  settings: Settings;
  updateSettings: UpdateSettings;
  resolvedTheme: "light" | "dark";
  toggleTheme: () => void;
}

const STEPS = [
  {
    label: "Agent",
    title: "Connect your coding agents",
    subtitle:
      "Connect the agents already installed on this computer. You can pick which one runs each task.",
    helper: "Connect at least one agent to start your first task.",
  },
  {
    label: "Projects",
    title: "Set up your projects",
    subtitle: "Choose where Patchwork should work. You can add and manage projects later.",
    helper: "Projects are optional. You can add more later.",
  },
  {
    label: "Plugins",
    title: "Choose your integrations",
    subtitle: "Enable the tools your workflow needs. Everything here is optional.",
    helper: "Integrations can be changed at any time in Settings.",
  },
  {
    label: "Devices",
    title: "Configure your devices",
    subtitle:
      "Choose where tasks run and how Patchwork connects to your development environments.",
    helper: "More devices can be added later.",
  },
];

const LAST_STEP = STEPS.length - 1;

export default function Onboarding({
  settings,
  updateSettings,
  resolvedTheme,
  toggleTheme,
}: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [saving, setSaving] = useState(false);
  // Connected agents, kept in AGENT_KINDS order so the first is the default.
  const [agents, setAgents] = useState<AgentKind[] | null>(null);
  const { probes, check, checking } = useAgentProbes();

  // Only ready agents can be selected. Start from the saved agents (or every
  // ready agent on first run), then keep the user's choices while still ready.
  useEffect(() => {
    if (checking) return;
    const ready = AGENT_KINDS.filter((k) => isReady(probes[k]));
    setAgents((current) => {
      const saved = settings.agents.filter((k) => ready.includes(k));
      const base = current ?? (saved.length > 0 ? saved : ready);
      return ready.filter((k) => base.includes(k));
    });
  }, [checking, probes, settings.agents]);

  const toggleAgent = (kind: AgentKind) =>
    setAgents((current) => {
      const set = current ?? [];
      const next = set.includes(kind) ? set.filter((k) => k !== kind) : [...set, kind];
      return AGENT_KINDS.filter((k) => next.includes(k));
    });

  const canContinue = !saving && (step !== 0 || (agents?.length ?? 0) > 0);
  const isLast = step === LAST_STEP;
  const current = STEPS[step];

  const goTo = (index: number) => {
    setStep(index);
    setReached((r) => Math.max(r, index));
  };

  const complete = () => updateSettings((s) => ({ ...s, onboarded: true }));

  const next = async () => {
    if (!canContinue) return;
    setSaving(true);
    try {
      if (isLast) {
        await complete();
      } else {
        if (step === 0 && agents) await updateSettings((s) => ({ ...s, agents }));
        goTo(step + 1);
      }
    } finally {
      setSaving(false);
    }
  };

  // Enter continues from anywhere that is not a text field or button, so it
  // never hijacks the project name input or a focused control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !canContinue) return;
      if (!(e.target instanceof HTMLElement)) return;
      if (e.target.closest("input, textarea, select, button, [contenteditable='true']")) return;
      e.preventDefault();
      void next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <AgentStep
            probes={probes}
            checking={checking}
            selected={agents ?? []}
            onToggle={toggleAgent}
            onRecheck={check}
          />
        );
      case 1:
        return <ProjectsStep settings={settings} updateSettings={updateSettings} />;
      case 2:
        return <PluginsStep settings={settings} updateSettings={updateSettings} />;
      default:
        return <DevicesStep />;
    }
  };

  return (
    <div className="ob-root">
      <header className="ob-header">
        <div className="ob-brand">
          <span className="ob-logo">P</span>
          <span className="ob-app-name">Patchwork</span>
        </div>

        <Stepper
          labels={STEPS.map((s) => s.label)}
          current={step}
          reached={reached}
          onSelect={goTo}
        />

        <div className="ob-header-actions">
          <button
            type="button"
            className="btn btn-icon"
            onClick={toggleTheme}
            title={resolvedTheme === "dark" ? "Dark theme (switch to light)" : "Light theme (switch to dark)"}
            aria-label="Toggle theme"
          >
            {resolvedTheme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button
            type="button"
            className="btn btn-ghost ob-skip"
            onClick={() => void complete()}
          >
            Skip setup
          </button>
        </div>
      </header>

      <main className="ob-body">
        <div className="ob-column">
          <h1 className="ob-title">{current.title}</h1>
          <p className="ob-subtitle">{current.subtitle}</p>
          <section className="card ob-card">{renderStep()}</section>
        </div>
      </main>

      <footer className="ob-footer">
        <div className="ob-column ob-footer-inner">
          <span className="ob-helper">{current.helper}</span>
          <div className="ob-footer-actions">
            {step > 0 && (
              <button type="button" className="btn btn-lg" onClick={() => goTo(step - 1)}>
                Back
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary btn-lg ob-continue"
              disabled={!canContinue}
              onClick={() => void next()}
            >
              {isLast ? (
                "Finish setup"
              ) : (
                <>
                  Continue <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
