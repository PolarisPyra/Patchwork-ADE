import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpIcon, SquareIcon } from "@phosphor-icons/react";
import { api, type AgentKind, type ModelOption } from "~/api";
import ModelPicker from "~/components/chat/ModelPicker";

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
        <ModelPicker agent={agent} model={model} agents={agents} models={models} onPick={onPickModel} />
        <span className="ws-spacer" />
        {working ? (
          <button className="ws-send ws-stop" onClick={onStop} title="Stop" aria-label="Stop">
            <SquareIcon size={12} weight="fill" />
          </button>
        ) : (
          <button
            className="ws-send"
            onClick={onSubmit}
            disabled={!value.trim()}
            title="Send"
            aria-label="Send"
          >
            <ArrowUpIcon size={16} />
          </button>
        )}
      </div>
      {error && <div className="ws-composer-error">{error}</div>}
    </div>
  );
}
