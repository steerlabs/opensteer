import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type DesktopGlassScene, type OpensteerGlassBridge } from "@opensteer/protocol/desktop";
import { GlassScene } from "./components/workspace/glass-scene.js";
import "@fontsource-variable/inter/wght.css";
import "./styles/index.css";
import "./styles/glass.css";

declare global {
  interface Window {
    readonly opensteerGlass?: OpensteerGlassBridge;
  }
}
function PageGlass() {
  const [scene, setScene] = useState<DesktopGlassScene | null>(null);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => window.opensteerGlass?.onScene(setScene), []);
  useEffect(() => {
    const resize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return scene ? <GlassScene scene={scene} {...size} /> : null;
}
const root = document.getElementById("root");
if (!root) throw new Error("Opensteer glass root was not found.");
createRoot(root).render(<PageGlass />);
