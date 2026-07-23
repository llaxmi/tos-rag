// Self-hosted, so no third-party round trip and no render-blocking external CSS.
// Cause is variable (200–800 in use); JetBrains Mono covers 400/500;
// Bricolage Grotesque is the display face for the hero h1 only.
import "@fontsource-variable/cause/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/bricolage-grotesque/index.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
