# @livemira/diagnostics

Two-level local diagnostic log (key and full) with bounded storage, sanitizing and numeric export.

## Dependencies

`@livemira/contracts`

## Public API

Private workspace package; the engine re-exports `DiagnosticLog`.

- `DiagnosticLog`: key and full levels (the level applies at each session start), allowlisted numeric records,
  bounded storage, export format `livemira-diagnostics/2`, host metadata and sections.
- `TelemetrySink`: what the engine reports to a diagnostic observer.
