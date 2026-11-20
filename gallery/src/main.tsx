import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// No StrictMode: several demos build GSAP timelines and canvases on mount,
// and a dev-only double mount would leave a second set running.
createRoot(document.getElementById("root")!).render(<App />);
