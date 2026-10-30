import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary, I18nProvider, ThemeProvider, Toasts } from "@hustradio/unitary-ui";
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ThemeProvider defaultTexture="solid"><I18nProvider locale="zh-CN"><ErrorBoundary><App /><Toasts className="shell-toasts" /></ErrorBoundary></I18nProvider></ThemeProvider></React.StrictMode>,
);
