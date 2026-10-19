import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronDown, Cpu, Square } from "lucide-react";
import { AGENT_LABELS, AGENT_MODELS, type AgentKind } from "../api";
import AgentIcon from "../components/AgentIcon";
import Dropdown from "./Dropdown";

interface ComposerProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  working: boolean;
  error: string | null;
  agent: AgentKind;
  model: string | null;
  /** The agent can only be changed before the first message. */
  canPickAgent: boolean;
  agents: AgentKind[];
  onAgentChange: (agent: AgentKind) => void;
  onModelChange: (model: string | null) => void;
}

export default function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  working,
  error,
  agent,
  model,
  canPickAgent,
  agents,
  onAgentChange,
  onModelChange,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content; CSS min/max-height keep it between about 3 and 14 rows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const modelLabel = AGENT_MODELS[agent].find((m) => m.id === model)?.label ?? "Default";

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="ws-composer">
      <textarea
        ref={ref}
        className="ws-composer-input selectable"
        rows={1}
        placeholder="Reply or describe the next change…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="ws-composer-foot">
        {canPickAgent && agents.length > 1 && (
          <Dropdown
            up
            trigger={({ toggle }) => (
              <button className="ws-chip-btn" onClick={toggle}>
                <AgentIcon kind={agent} size={14} />
                {AGENT_LABELS[agent]}
                <ChevronDown size={12} />
              </button>
            )}
          >
            {(close) =>
              agents.map((kind) => (
                <button
                  key={kind}
                  className="ws-menu-item"
                  onClick={() => {
                    close();
                    onAgentChange(kind);
                  }}
                >
                  <span className="ws-check">{kind === agent && <Check size={13} />}</span>
                  {AGENT_LABELS[kind]}
                </button>
              ))
            }
          </Dropdown>
        )}
        <Dropdown
          up
          trigger={({ toggle }) => (
            <button className="ws-chip-btn" onClick={toggle}>
              <Cpu size={14} />
              {modelLabel}
              <ChevronDown size={12} />
            </button>
          )}
        >
          {(close) =>
            AGENT_MODELS[agent].map((m) => (
              <button
                key={m.label}
                className="ws-menu-item"
                onClick={() => {
                  close();
                  onModelChange(m.id);
                }}
              >
                <span className="ws-check">{m.id === model && <Check size={13} />}</span>
                {m.label}
              </button>
            ))
          }
        </Dropdown>
        <span className="ws-spacer" />
        {working ? (
          <button className="ws-send ws-stop" onClick={onStop} title="Stop" aria-label="Stop">
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            className="ws-send"
            onClick={onSubmit}
            disabled={!value.trim()}
            title="Send"
            aria-label="Send"
          >
            <ArrowUp size={16} />
          </button>
        )}
      </div>
      {error && <div className="ws-composer-error">{error}</div>}
    </div>
  );
}
