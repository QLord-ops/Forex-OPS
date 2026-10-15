# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-10-14 (dashboard quick Auftrag intake and cargo metadata)
- Primary product surfaces: Dispatcher dashboard, vehicle detail/map, tours, new order form, alerts, vehicle history.
- Evidence reviewed: User-provided product specification in the Codex attachment; repository contained no prior UI or brand assets.

## Brand
- Personality: Operational, exact, calm, trustworthy, German logistics control room.
- Trust signals: Explicit timestamps, route provenance, visible calculation state, persistent warnings, clear separation of calculated data from GPS data.
- Avoid: Decorative marketing cards, glossy gradients, playful illustration, ambiguous status colors, the terms "Live Position" and "Echtzeitposition".

## Product goals
- Goals: Let one dispatcher understand every truck's current calculated movement, ETA, delay risk, and queued work within seconds.
- Non-goals: Driver workflow, mobile app, accounting, CRM, bidirectional Webfleet job dispatch, multi-user administration.
- Success signals: A dispatcher can create an order from a file with one confirmation, monitor fresh Webfleet GPS when configured, confirm loading/unloading from the fleet rail, and identify endangered appointments or excessive dwell without leaving the dashboard.

## Personas and jobs
- Primary personas: One desktop dispatcher managing a small fleet.
- User jobs: Create and sequence tours; confirm operational events; detect late appointments; inspect current and future schedules; review immutable event history.
- Key contexts of use: Long desktop sessions on a MacBook, frequent scanning, periodic updates, operational urgency.

## Information architecture
- Primary navigation: Dashboard, Fahrzeuge, Touren, Neuer Auftrag, Warnungen, Historie.
- Core routes/screens: `/`, `/vehicles`, `/vehicles/:id`, `/tours`, `/tours/:id/edit`, `/orders/new`, `/alerts`, `/history`.
- Content hierarchy: Urgency-sorted vehicle rail first; fullscreen selected-vehicle map second; vehicle metrics and route stops appear as overlays on the map; editing/creation flows follow operational monitoring.

## Design principles
- Principle 1: Dense but legible — tables and timelines carry the information, with minimal chrome.
- Principle 2: Every position and estimate states its origin; fresh Webfleet GPS, stale GPS and calculated positions are visually distinct.
- Principle 3: Color reinforces explicit text and never carries meaning alone.
- Principle 4: Operational monitoring uses the full viewport; scrolling is confined to the fleet rail and expandable overlays instead of the dashboard document.
- Tradeoffs: Desktop-first density over small-screen optimization; operational clarity over visual novelty.

## Visual language
- Color: Light control-center workspace with compact navy navigation, white work surfaces, blue selection/accent, and semantic red/orange/yellow/blue/green/grey attention states. Color always has a text label and icon/context.
- Typography: System sans-serif with tabular numerals for times, distances, and vehicle numbers.
- Spacing/layout rhythm: Compact 4/8 px rhythm; no global desktop header; 80 px desktop navigation rail below 1536 px; 340–380 px vehicle rail; fullscreen map workspace; 44–52 px table rows.
- Shape/radius/elevation: 6–10 px radii, restrained borders, almost no shadows.
- Motion: Short state transitions only; truck marker may move smoothly between calculated positions; map HUD and route drawer reveal in 180–240 ms and honor reduced motion.
- Imagery/iconography: Functional line icons; MapLibre is the rendering surface with traffic and satellite modes. Provider attribution remains visible.

## Components
- Existing components to reuse: App shell, status badges, data table, map panel, timeline, order import preview, appointment planner and operational states.
- New/changed components: Urgency-sorted vehicle rail with fixed-height contextual actions, fullscreen free-camera map, traffic/satellite switcher, one-shot camera controls, floating vehicle HUD, expandable route-stop drawer, collapsible right-side Tour/Auftrag panel, import review modal, filter chips, shared local page headers, work surfaces, icon buttons and overflow-safe text treatments.
- Variants and states: dwell-critical VIOLET (highest priority), deadline RED, action ORANGE, watch YELLOW, moving BLUE, on-plan GREEN, idle GREY; waiting is visible from minute one; Webfleet fresh/stale/calculated source states; DONE/CURRENT/NEXT/QUEUED; loading/arrived/waiting/cancelled.
- Token/component ownership: CSS custom properties and Tailwind theme in the web app; shared primitives under `apps/web/src/components`.

## Accessibility
- Target standard: WCAG 2.1 AA for core dispatcher flows.
- Keyboard/focus behavior: All navigation, forms, rows, and actions keyboard reachable with visible focus.
- Contrast/readability: Status text always accompanies color; body text and table values meet AA contrast.
- Screen-reader semantics: Semantic tables, headings, labels, live status text, and button names include the stop action.
- Reduced motion and sensory considerations: Honor `prefers-reduced-motion`; do not use blinking alerts.

## Responsive behavior
- Supported breakpoints/devices: Primary 1280–1728 px MacBook desktop; usable down to 1024 px; narrow screens scroll dense tables horizontally.
- Layout adaptations: From 1100 px the dashboard uses vehicle rail + map; below it the vehicle cards become a horizontal rail above the map. Side navigation becomes a compact top strip below 1024 px.
- Touch/hover differences: Desktop map HUD expands on hover and focus; touch uses an explicit tap toggle. Card actions use a fixed action rail and portal popover so cards never resize. No action is hover-only; primary buttons maintain at least 40 px height.

## Interaction states
- Loading: Inline skeleton/quiet progress label without hiding existing data.
- Empty: Explain the next operational action, such as creating a vehicle or order.
- Error: Persistent German error message with retry where safe.
- Success: Immediate data refresh and concise confirmation.
- Disabled: Explain sequencing constraints (for example, unload before load).
- Offline/slow network: Keep the last visible state and show refresh age; stale Webfleet GPS is never silently replaced by a calculated position; routing fallback is clearly identified.

## Auftrag import flow
- Default entry: PDF, Excel or screenshot import from the dashboard or dedicated page with automatic vehicle matching, city, appointment and coordinate resolution.
- Dashboard pattern: A collapsible right overlay keeps the map as the primary surface. It has only Tour and New Auftrag tabs; importing opens a focused modal and never navigates away from fleet monitoring.
- Review actions: Exactly two primary actions after recognition — Edit and Confirm. Confirm creates the Auftrag; there is no separate coordinate-check or save step.
- Editing: Each loading/unloading card opens inline; unresolved addresses automatically open the affected card and block confirmation.
- Cargo metadata: LDM/loading meters, stop-specific references and operational notes are optional, editable and visible on route stop cards. Their absence never blocks confirmation.
- Privacy: Uploaded source files are processed in memory and are not retained by the application.
- Stop defaults: Manual creation starts with Load then Unload. Normal dwell is 60 minutes and critical dwell is 120 minutes; these defaults are shown as compact metadata rather than editable table columns.

## Content voice
- Tone: Concise operational German.
- Terminology: Auftrag, Tour, LKW, Ladestelle, Entladestelle, Termin, ETA, Verspätung, Berechnete Position.
- Microcopy rules: Always show units; use exact timestamps; mandatory map disclaimer is “Berechnete Position – keine GPS-Daten”.

## Implementation constraints
- Framework/styling system: React, TypeScript, Vite, Tailwind CSS, MapLibre GL JS.
- Design-token constraints: CSS custom properties plus existing Tailwind utilities; no second component framework. Shared controls must use the common button/input/surface/status classes.
- Performance constraints: Dashboard state refresh every 10 seconds; map updates never reset a dispatcher-controlled camera. Webfleet sync is globally leased and quota-aware; routing/traffic recalculation remains separate from telemetry refresh.
- Compatibility constraints: Local macOS launch via `npm install` and `npm run dev`; desktop Safari/Chrome current versions.
- Test/screenshot expectations: Business calculations have unit tests; core pages receive build/type checks and manual smoke verification.

## Webfleet and map contract
- Webfleet is read-only in v1 and supplies actual vehicle telemetry; driver data is neither requested nor stored.
- Automatic arrival requires two fresh points inside 1 km with speed at or below 20 km/h. Loading and unloading remain dispatcher-confirmed.
- The map opens near the selected truck at building-level zoom. Polling updates data layers only; camera changes occur only on vehicle selection or explicit controls.
- Traffic mode is the default. Satellite and traffic layers use a browser-restricted TomTom map key and degrade to attributed OSM when unavailable.

## Open questions
- [ ] Whether appointment timestamps should be displayed in a fixed depot timezone when used outside Europe/Berlin / owner / future deployment concern.
