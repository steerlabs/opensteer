# Changelog

All notable changes to this project should be recorded in this file.

## Unreleased

## 0.8.16 - 2026-04-08

- Refined request tooling around exec-driven flows, transport probing, and CLI/runtime selection
- Normalized DOM runtime persist keys and trimmed snapshot interaction output to reduce agent-facing noise
- Updated protocol and runtime internals to match the new request flow behavior with added regression coverage

## 0.8.0 - 2026-03-27

- Added stable browser-native instrumentation APIs for init scripts, routing, script interception, and script capture
- Added page lifecycle, page evaluation, and network wait primitives to the SDK
- Added browser-backed replay support for `context-http` and `page-eval-http` with improved recipe and request-plan integration
- Added script-source artifact persistence and fixture coverage for instrumentation workflows
