import { useCallback, useEffect, useState } from "react";
import { api, type AgentKind, type AgentStatus } from "../api";

export const AGENT_KINDS: AgentKind[] = ["claude", "codex"];

export interface AgentProbe {
  checking: boolean;
  status: AgentStatus | null;
  failed: boolean;
}

export type AgentProbes = Record<AgentKind, AgentProbe>;

/** An agent is usable only when it is installed and signed in. */
export function isReady(probe: AgentProbe): boolean {
  return probe.status !== null && probe.status.installed && probe.status.signedIn;
}

const CHECKING: AgentProbe = { checking: true, status: null, failed: false };

/** Detects all agents in parallel on mount; `check` re-runs detection. */
export function useAgentProbes() {
  const [probes, setProbes] = useState<AgentProbes>({ claude: CHECKING, codex: CHECKING });

  const check = useCallback(() => {
    setProbes((p) => ({
      claude: { ...p.claude, checking: true },
      codex: { ...p.codex, checking: true },
    }));
    for (const kind of AGENT_KINDS) {
      api.detectAgent(kind).then(
        (status) => setProbes((p) => ({ ...p, [kind]: { checking: false, status, failed: false } })),
        () => setProbes((p) => ({ ...p, [kind]: { checking: false, status: null, failed: true } })),
      );
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  return { probes, check, checking: AGENT_KINDS.some((k) => probes[k].checking) };
}
