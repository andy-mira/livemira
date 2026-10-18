# @livemira/page-shell

Private workspace package: the full-screen page shell shared by the public demo and the private test pages.
Plain TypeScript and DOM, no runtime dependencies.

- `mountShell()` fixes the page to the viewport (no scrolling, no rubber-band bounce) and returns a full-screen
  stage for the engine and a floating layer bounded by the safe area.
- `FloatingDock` — round buttons in a corner; each opens one collapsible panel; one panel is open at a time and
  the open panel is remembered per page.
- `StatusBadge`, `Toast`, `FullscreenPrompt`, `DiagnosticsPanel`.
