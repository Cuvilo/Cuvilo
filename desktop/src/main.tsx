import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {prepareTheme} from "./hooks/use-theme";
import "./styles.css";
document.documentElement.dataset.window=new URLSearchParams(location.search).get("window")==="answer"?"answer":"main";
prepareTheme();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
