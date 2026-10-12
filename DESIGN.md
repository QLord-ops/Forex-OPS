# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-10-12
- Primary product surfaces: Dispatcher dashboard, vehicle detail/map, tours, new order form, alerts, vehicle history.
- Evidence reviewed: User-provided product specification in the Codex attachment; repository contained no prior UI or brand assets.

## Brand
- Personality: Operational, exact, calm, trustworthy, German logistics control room.
- Trust signals: Explicit timestamps, route provenance, visible calculation state, persistent warnings, clear separation of calculated data from GPS data.
- Avoid: Decorative marketing cards, glossy gradients, playful illustration, ambiguous status colors, the terms "Live Position" and "Echtzeitposition".

## Product goals
- Goals: Let one dispatcher understand every truck's current calculated movement, ETA, delay risk, and queued work within seconds.
- Non-goals: GPS tracking, driver workflow, mobile app, accounting, CRM, Webfleet integration, multi-user administration.
- Success signals: A dispatcher can create an order, confirm loading/unloading, see the truck move on the routed polyline, and identify endangered appointments without manual calculation.

## Personas and jobs
- Primary personas: One desktop dispatcher managing a small fleet.
- User jobs: Create and sequence tours; confirm operational events; detect late appointments; inspect current and future schedules; review immutable event history.
- Key contexts of use: Long desktop sessions on a MacBook, frequent scanning, periodic updates, operational urgency.

## Information architecture
- Primary navigation: Dashboard, Fahrzeuge, Touren, Neuer Auftrag, Warnungen, Historie.
- Core routes/screens: `/`, `/vehicles`, `/vehicles/:id`, `/tours`, `/tours/:id/edit`, `/orders/new`, `/alerts`, `/history`.
- Content hierarchy: Urgency-sorted vehicle rail first; selected vehicle map and current-tour controls second; route timeline third; editing/creation flows after operational monitoring.

## Design principles
- Principle 1: Dense but legible — tables and timelines carry the information, with minimal chrome.
- Principle 2: Every estimate states its status and origin; calculated position is never presented as telemetry.
- Principle 3: Color reinforces explicit text and never carries meaning alone.
- Tradeoffs: Desktop-first density over small-screen optimization; operational clarity over visual novelty.

## Visual language
- Color: Light control-center workspace with compact navy navigation, white work surfaces, blue selection/accent, and semantic red/orange/yellow/blue/green/grey attention states. Color always has a text label and icon/context.
- Typography: System sans-serif with tabular numerals for times, distances, and vehicle numbers.
- Spacing/layout rhythm: Compact 4/8 px rhythm; 64 px header; 80 px desktop navigation rail below 1536 px; 340–380 px vehicle rail; 44–52 px table rows.
- Shape/radius/elevation: 6–10 px radii, restrained borders, almost no shadows.
- Motion: Short state transitions only; truck marker may move smoothly between calculated positions.
- Imagery/iconography: Functional line icons; MapLibre/OpenStreetMap map is the primary visual surface.

## Components
- Existing components to reuse: App shell, status badges, data table, map panel, timeline, order import preview, appointment planner and operational states.
- New/changed components: Urgency-sorted vehicle rail, map workspace toolbar, route stop cards, filter chips, shared page headers, work surfaces, icon buttons and overflow-safe text treatments.
- Variants and states: GREEN/YELLOW/ORANGE/RED/GREY; DONE/CURRENT/NEXT/QUEUED; loading/arrived/waiting/cancelled.
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
- Touch/hover differences: No hover-only actions; primary buttons maintain at least 40 px height.

## Interaction states
- Loading: Inline skeleton/quiet progress label without hiding existing data.
- Empty: Explain the next operational action, such as creating a vehicle or order.
- Error: Persistent German error message with retry where safe.
- Success: Immediate data refresh and concise confirmation.
- Disabled: Explain sequencing constraints (for example, unload before load).
- Offline/slow network: Keep the last visible state and show that refresh failed; routing falls back to a clearly identified local approximation.

## Content voice
- Tone: Concise operational German.
- Terminology: Auftrag, Tour, LKW, Ladestelle, Entladestelle, Termin, ETA, Verspätung, Berechnete Position.
- Microcopy rules: Always show units; use exact timestamps; mandatory map disclaimer is “Berechnete Position – keine GPS-Daten”.

## Implementation constraints
- Framework/styling system: React, TypeScript, Vite, Tailwind CSS, MapLibre GL JS.
- Design-token constraints: CSS custom properties plus existing Tailwind utilities; no second component framework. Shared controls must use the common button/input/surface/status classes.
- Performance constraints: Backend state refresh every 30 seconds; marker interpolation every 5 seconds without database writes.
- Compatibility constraints: Local macOS launch via `npm install` and `npm run dev`; desktop Safari/Chrome current versions.
- Test/screenshot expectations: Business calculations have unit tests; core pages receive build/type checks and manual smoke verification.

## Open questions
- [ ] Production HERE Truck Routing credentials and truck restrictions / owner / required only for later provider replacement.
- [ ] Whether appointment timestamps should be displayed in a fixed depot timezone when used outside Europe/Berlin / owner / future deployment concern.
