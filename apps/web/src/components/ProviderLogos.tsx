import type { AgentKind } from "~/api";
import claudeIcon from "../../../../assets/claude-color.svg";
import geminiIcon from "../../../../assets/gemini-color.svg";
import openaiIcon from "../../../../assets/openai.svg";

const LOGOS: Record<AgentKind, string> = { claude: claudeIcon, codex: openaiIcon, gemini: geminiIcon };

/** Brand-ish marks for the supported agents. Inherits size from `size`. */
export default function ProviderLogos({ kind, size = 20 }: { kind: AgentKind; size?: number }) {
  return <img src={LOGOS[kind]} width={size} height={size} alt="" aria-hidden="true" />;
}
