import React from "react";
import ReactDOM from "react-dom/client";
import "./app.css";
import { App } from "./App.jsx";
import { ErrorBoundary } from "./components/common.jsx";

const mount = (() => {
  const found = document.getElementById("root");
  if (found) return found;
  Array.from(document.body.children).forEach(el => {
    if (el.tagName !== "SCRIPT" && el.tagName !== "NOSCRIPT" &&
        /Loading VagaboNDE/i.test(el.textContent || "")) el.remove();
  });
  const made = document.createElement("div");
  made.id = "root";
  document.body.insertBefore(made, document.body.firstChild);
  return made;
})();

ReactDOM.createRoot(mount).render(
  <ErrorBoundary resetKey="root"><App /></ErrorBoundary>
);
