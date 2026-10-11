import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import { isWindows } from "./platform";
import { RecordingHud } from "./RecordingHud";
import "./styles.css";

const isHud = window.location.hash === "#hud";
if (isHud) document.documentElement.classList.add("hud");
if (isWindows) document.documentElement.classList.add("windows");
// On macOS the desktop shell renders the window background as native Liquid Glass.
else if ("__TAURI_INTERNALS__" in window) document.documentElement.classList.add("glass");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>{isHud ? <RecordingHud /> : <App />}</I18nProvider>
  </StrictMode>,
);
