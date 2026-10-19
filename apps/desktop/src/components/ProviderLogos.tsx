import type { AgentKind } from "../api";
import claudeIcon from "../../../../assets/claude-color.svg";
import openaiIcon from "../../../../assets/openai.svg";

/** Brand-ish marks for the supported agents. Inherits size from `size`. */
export default function ProviderLogos({ kind, size = 20 }: { kind: AgentKind; size?: number }) {
  return <img src={kind === "claude" ? claudeIcon : openaiIcon} width={size} height={size} alt="" aria-hidden="true" />;
}
