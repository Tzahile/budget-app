import { createRoot } from "react-dom/client";
import { setup } from "@twind/core";
import presetTailwind from "@twind/preset-tailwind";
import { App } from "../../frontend/components/App.tsx";

// Same utility classes as production, compiled locally; no CDN dependency.
setup({
  presets: [presetTailwind()],
  // Twind's pinned preset predates Tailwind's 950 shades used by production.
  theme: { extend: { colors: { green: { 950: "#052e16" }, stone: { 950: "#0c0a09" } } } },
});
createRoot(document.getElementById("root")!).render(<App />);
