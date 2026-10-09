import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RecordingHud } from "./RecordingHud";
import "./styles.css";

const isHud = window.location.hash === "#hud";
if (isHud) document.documentElement.classList.add("hud");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isHud ? <RecordingHud /> : <App />}
  </StrictMode>,
);
