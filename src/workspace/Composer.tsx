import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronDown, Square } from "lucide-react";
import { api, AGENT_LABELS, type AgentKind, type ModelOption } from "../api";
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
  /** Agents whose models are offered (only the thread's own once it has started). */
  agents: AgentKind[];
  /** Picking another agent's model switches the agent too. */
  onPickModel: (agent: AgentKind, model: string | null) => void;
}

/** Models per agent, fetched once per agent kind. */
function useModels(agents: AgentKind[]): Partial<Record<AgentKind, ModelOption[]>> {
  const [models, setModels] = useState<Partial<Record<AgentKind, ModelOption[]>>>({});
  const wanted = agents.join(",");
  useEffect(() => {
    let cancelled = false;
    for (const kind of wanted.split(",") as AgentKind[]) {
      api.listModels(kind).then(
        (list) => {
          if (!cancelled) setModels((prev) => (prev[kind] ? prev : { ...prev, [kind]: list }));
        },
        () => {},
      );
    }
    return () => {
      cancelled = true;
    };
  }, [wanted]);
  return models;
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
  agents,
  onPickModel,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content; CSS min/max-height keep it between about 3 and 14 rows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const models = useModels(agents);
  // An unknown id (e.g. a model no longer listed) is still shown by its id.
  const modelLabel = models[agent]?.find((m) => m.id === model)?.label ?? model ?? "Default";

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
        <Dropdown
          up
          trigger={({ toggle }) => (
            <button className="ws-chip-btn" onClick={toggle} title={`${AGENT_LABELS[agent]} · ${modelLabel}`}>
              <AgentIcon kind={agent} size={14} />
              {modelLabel}
              <ChevronDown size={12} />
            </button>
          )}
        >
          {(close) => (
            <div className="ws-model-menu">
              {agents.map((kind) => (
                <div key={kind} role="group" aria-label={AGENT_LABELS[kind]}>
                  <div className="ws-menu-group">
                    <AgentIcon kind={kind} size={12} />
                    {AGENT_LABELS[kind]}
                  </div>
                  {(models[kind] ?? []).map((m) => (
                    <button
                      key={m.id ?? "default"}
                      className="ws-menu-item"
                      onClick={() => {
                        close();
                        onPickModel(kind, m.id);
                      }}
                    >
                      <span className="ws-check">
                        {kind === agent && m.id === model && <Check size={13} />}
                      </span>
                      {m.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
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
