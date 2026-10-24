import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {prepareTheme} from "./hooks/use-theme";
import "./styles.css";
import {prepareLanguage} from "./i18n";
document.documentElement.dataset.window=new URLSearchParams(location.search).get("window")==="answer"?"answer":"main";
prepareTheme();
prepareLanguage();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
