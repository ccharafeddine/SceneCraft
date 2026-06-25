import "./App.css";

// Step 1: an empty, themed window. The three-region layout (Cast / Prompt /
// Settings) arrives in later steps. This shell only proves the stack runs and
// that light/dark theming + the system font are wired through CSS custom
// properties.
function App() {
  return (
    <main class="app-shell">
      <div class="app-shell__placeholder">
        <h1 class="app-shell__wordmark">Scenecraft</h1>
        <p class="app-shell__tagline">Pick character(s), describe a scene, generate.</p>
      </div>
    </main>
  );
}

export default App;
