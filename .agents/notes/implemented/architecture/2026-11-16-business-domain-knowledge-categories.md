# Agent Note: Business-domain knowledge spaces and automatic routing

Status: implemented

English | [中文](2026-11-16-business-domain-knowledge-categories.zh.md)

## Problem

The knowledge dashboard originally exposed a small flat set of spaces whose names mixed business ownership with document genres. It lacked stable macro-level homes for office records, learning material, and technical documentation, so an Agent had to guess where unrelated documents belonged. The Wiki workbench also grew into a tall three-column page whose long draft preview captured scrolling and obscured review actions.

## Decision

The built-in catalog is organized by long-term knowledge purpose. `finance`, `hr`, `ops`, `project_analysis`, and `review` are flat spaces. `office_docs`, `learning`, `technical_docs`, `smart_query`, and `content_creation` use stable document-type categories with at most two segments. Flat spaces do not create categories, including for Wiki publication.

Draft creation routes by ownership first, then long-term use, conclusion type, and document type. The deterministic classifier sends project conclusions to `project_analysis`, office records to `office_docs`, learning material to `learning`, technical implementation documentation to `technical_docs`, data knowledge to `smart_query`, reusable templates to `content_creation`, and uncertain material to `review`. An explicit target may override the classifier. The Wiki workbench presents the routing order, an automatic-import control, a two-column review queue, and supporting category/index/log panels below the main review surface. Long draft text is collapsed behind an explicit full-text action.

## Alternatives considered

**Keep one domain per built-in workflow.** Rejected because office reports, learning notes, and technical documentation cross workflow boundaries; workflow ownership is too narrow for long-term retrieval.

**Use document type as the top level.** Rejected because a weekly report, meeting note, and system plan all belong to office collaboration, while a project analysis and an architecture document need different ownership even when both are technical.

**Make every domain flat.** Rejected because office records, learning material, technical documentation, data knowledge, and reusable content each contain stable, repeated document types that benefit from one level of grouping.

**Force every domain to use categories.** Rejected because finance, HR, operations, project analysis, and review are small or policy-shaped collections where an additional directory only adds navigation cost.

**Put the full draft preview in an inner scroll box.** Rejected because wheel input stays inside the preview for thousands of pixels and makes the page appear unable to scroll.

## Consequences

The ten dashboard entries now describe stable long-term knowledge purposes. Documents have one primary domain; related material is linked rather than duplicated. Flat domains retain simple direct access, while categorized domains expose stable document types. Existing categories under flat domains are cleared when the repository opens. The deterministic router is a first-pass classifier; agents can provide an explicit target when context is stronger. Low-confidence material remains visible in `review` instead of being mislabeled.

## Testing

Knowledge tests cover automatic domain routing, flat-space publication, categorized Wiki publication, category-only moves, persistence, and legacy migration. Client tests cover category trees and Wiki APIs. Browser checks at 900, 1280, and 1920 CSS pixels verify page scrolling, dashboard opening, Vault opening, draft preview collapse, and zero console errors.
