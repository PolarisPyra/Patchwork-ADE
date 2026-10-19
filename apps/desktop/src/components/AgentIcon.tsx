import type { AgentKind } from "../api";

/** Brand-ish marks for the supported agents. Inherits size from `size`. */
export default function AgentIcon({ kind, size = 20 }: { kind: AgentKind; size?: number }) {
  if (kind === "claude") {
    const rays = Array.from({ length: 12 }, (_, i) => i * 30);
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        {rays.map((deg) => (
          <line
            key={deg}
            x1="12"
            y1="12"
            x2="12"
            y2={deg % 60 === 0 ? 2 : 4}
            stroke="#d97757"
            strokeWidth="2.2"
            strokeLinecap="round"
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--text)" />
      <path
        d="M7 8.5 10.5 12 7 15.5M12.5 16h4.5"
        stroke="var(--bg-editor)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
