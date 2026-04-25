import { useEffect, useState } from "react";
import { getHealth, type HealthResponse } from "../api/client";

function formatAge(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function StatusBar() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [agentOk, setAgentOk] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await getHealth();
        if (!alive) return;
        setAgentOk(h.ok);
        setHealth(h);
      } catch {
        if (!alive) return;
        setAgentOk(false);
        setHealth(null);
      }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const extConnected = health?.extension_connected ?? null;
  const stats = health?.ws_stats;
  const tokenAge = formatAge(stats?.token_age_s ?? null);
  const reqCount = stats?.request_count ?? 0;
  const okCount = stats?.success_count ?? 0;
  const failCount = stats?.failed_count ?? 0;

  const agentLabel = agentOk ? "● agent" : "○ agent";
  const extLabel =
    extConnected === null ? "? extension" : extConnected ? "● extension" : "○ extension";

  return (
    <div className="statusbar">
      <span style={{ color: agentOk ? "#6ee7b7" : "#ef4444" }}>{agentLabel}</span>
      <span style={{ margin: "0 8px", opacity: 0.4 }}>|</span>
      <span style={{ color: extConnected ? "#6ee7b7" : "#8a8f99" }}>{extLabel}</span>
      {extConnected && stats?.flow_key_present && tokenAge && (
        <>
          <span style={{ margin: "0 8px", opacity: 0.4 }}>|</span>
          <span style={{ color: "#8a8f99" }}>token {tokenAge}</span>
        </>
      )}
      {extConnected && reqCount > 0 && (
        <>
          <span style={{ margin: "0 8px", opacity: 0.4 }}>|</span>
          <span style={{ color: "#8a8f99" }}>
            req {reqCount} · <span style={{ color: "#6ee7b7" }}>✓{okCount}</span>
            {failCount > 0 && <> · <span style={{ color: "#ef4444" }}>✗{failCount}</span></>}
          </span>
        </>
      )}
    </div>
  );
}
