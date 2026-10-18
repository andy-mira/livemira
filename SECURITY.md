# Security policy

[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

## Supported versions

| Version | Supported                                                                                 |
| ------- | ----------------------------------------------------------------------------------------- |
| 0.3.x   | Yes                                                                                       |
| 0.2.x   | No: please move to 0.3 (see the [migration notes](documentation/migration-0.2-to-0.3.md)) |

## Reporting a vulnerability

Please report vulnerabilities privately, through the private vulnerability reporting of the repository's hosting
service. Do not open a public issue. Include the affected version (`engineBuildInfo` shows it), the browser and
device, and the steps to reproduce.

You will receive an acknowledgement, and a fix is released before the details are made public.

## Scope

LiveMira runs entirely in the browser: it sends no requests of its own, loads no code at run time and uploads
nothing. Of particular interest are:

- inputs the engine parses: target files (`parseTarget`), images, media URLs and files;
- the Worker protocol and the embedded WebAssembly;
- content security policy requirements (`blob:` Workers, `wasm-unsafe-eval`);
- the diagnostic log, which must contain no pictures, URLs or point coordinates.
