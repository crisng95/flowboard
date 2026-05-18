import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "@xyflow/react/dist/style.css";
// V2 Tailwind layer is loaded BEFORE the legacy stylesheet so the v1
// rules in styles.css keep their natural precedence — zero regression
// risk while the migration is in progress.
import "./globals.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
