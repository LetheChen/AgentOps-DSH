# Agent Note: Collapsible sidebar panel sections

Status: implemented

English | [中文](2026-10-29-collapsible-sidebar-sections.zh.md)

## Problem

Client plugins can contribute independent rows to `sidebar.panellist`, but the sidebar renders every row as a flat navigation item. A deployment that needs related panels under one top-level heading cannot express that grouping through a profile, bundle, or preset. Copying the sidebar into a product plugin would fork generic navigation, accessibility, pinning, and collapse behavior.

## Decision

List registrations may carry optional `section` metadata containing a stable id, optional order, and locale-aware label. `ui-slots` copies that metadata with the stored registration. `ui-sidebar` validates that all registrations sharing an id agree on label and order, groups their pinned rows into one collapsible section, and derives section order from metadata or the earliest child when omitted. Selecting a child opens its section; the More menu remains a flat list of individual panels.

## Alternatives considered

**Hard-code AgentOps group ids in the sidebar.** Rejected because the sidebar is a generic DSH package and would acquire product-specific knowledge.

**Render grouping inside the AgentOps client plugin.** Rejected because a plugin contributes panel rows, not the sidebar container; reproducing the navigation shell would duplicate pinning, collapse, keyboard, and accessibility behavior.

**Require a separate nested-slot declaration for every group.** Rejected because grouping is presentation metadata over existing independent panel registrations, not a new composition position or lifecycle.

## Consequences

Plugins can now group related panels without changing the sidebar implementation per product. The sidebar enforces consistent metadata for one section and keeps unpinned entries individually addressable. Group state is in-memory UI state, so it resets on reload and is not session or profile data. A malformed section label or order fails at registration synchronization instead of silently producing duplicate headings.

## Testing

Focused client tests cover metadata copying, conflicting section metadata, collapsible rendering, active-section expansion, section interaction from the collapsed sidebar, and flat More-menu behavior. The affected `ui-sidebar` and `ui-slots` suites pass with 57 tests.