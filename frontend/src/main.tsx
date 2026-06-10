import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { CloudPortal } from "./cloud/CloudPortal";
import "@xyflow/react/dist/style.css";
// V2 Tailwind layer is loaded BEFORE the legacy stylesheet so the v1
// rules in styles.css keep their natural precedence — zero regression
// risk while the migration is in progress.
import "./globals.css";
import "./styles.css";

const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const isDebugMode =
  window.location.pathname === "/debug"
  || (isLocalHost && import.meta.env.VITE_FLOWBOARD_DEBUG_PORTAL === "1");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDebugMode ? <CloudPortal /> : <App />}
  </React.StrictMode>,
);
