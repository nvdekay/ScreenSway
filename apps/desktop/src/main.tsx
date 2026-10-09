import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RecordingHud } from "./RecordingHud";
import "./styles.css";

const isHud = window.location.hash === "#hud";
if (isHud) document.documentElement.classList.add("hud");
// The desktop shell renders the window background as native Liquid Glass.
if ("__TAURI_INTERNALS__" in window) document.documentElement.classList.add("glass");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isHud ? <RecordingHud /> : <App />}
  </StrictMode>,
);
