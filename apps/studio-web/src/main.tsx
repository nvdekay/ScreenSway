import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../desktop/src/i18n";
import "../../desktop/src/styles.css";
import "./web.css";
import { WebApp } from "./WebApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <WebApp />
    </I18nProvider>
  </StrictMode>,
);
