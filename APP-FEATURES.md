# NexLet — Full App Feature Audit

NexLet (referred to as VillaAgent in parts of the codebase) is a B2B2C marketplace connecting luxury villa/estate owners with professional booking agents, who in turn sell stays to their own end clients. The core workflow is **search → book → sign contract → pay → manage**: an agent searches published listings, creates a booking (instant-book or owner-approved request), a DocuSign contract is generated and routed for three-party signature, the client pays via Stripe (deposit/balance split plus an optional refundable security deposit), and the booking is then managed through to check-out — including messaging, calendar/iCal sync, damage claims, and owner/agent payouts. Three roles drive the platform: **Owner** (lists villas, manages pricing/availability, approves bookings, receives payouts), **Agent** (searches inventory, creates bookings on behalf of clients, builds branded client-facing "Selections," manages sub-agent teams), and **Admin** (reviews and approves agent applications and property listings — a deliberately minimal, two-queue dashboard with no broader staff tooling).

This document is a section-by-section audit of what is actually implemented in the source code (repo: `villaAgentBooking`), written for accuracy rather than marketing polish — each section was produced by independently reading the real source files for that area, and includes concrete file references plus explicit notes on what's stubbed, disconnected, or untested.

## Table of Contents

1. [Property Listings, Search & Calendar](#property-listings-search-calendar)
2. [Bookings, Contracts & Deposits](#bookings-contracts-deposits)
3. [Payments, Billing, Insurance & Claims](#payments-billing-insurance-claims)
4. [Agents, Agencies & Reputation](#agents-agencies-reputation)
5. [Messaging, Notifications & Push](#messaging-notifications-push)
6. [Collections, Selections & Clients](#collections-selections-clients)
7. [Admin, Auth & Infrastructure](#admin-auth-infrastructure)
8. [Background Jobs & Email](#background-jobs-email)
9. [API Routes](#api-routes)
10. [Mobile-Responsive Web & PWA (Shipped)](#mobile-responsive-web-pwa-shipped)
11. [Mobile App — Expo Rewrite (In Progress)](#mobile-app-expo-rewrite-in-progress)
12. [Testing & CI Coverage](#testing-ci-coverage)
13. [Incomplete / Not Yet Verified (rollup)](#incomplete-not-yet-verified)

---

## Property Listings, Search & Calendar

### 1. Listing data model & fields
A `Property` record (`prisma/schema.prisma:47-121`) holds: name/slug, `propertyType` (villa/estate/chalet/apartment/penthouse), location (country/region/city/address/lat/lng), capacity (maxGuests/bedrooms/bathrooms — all int, min 1), six **structured** description fields (overview, bedrooms, bathrooms, outdoor spaces, staff, location — no single free-text blob), `baseCurrency` (one of EUR/USD/GBP/CHF/THB/AED/AUD, enforced by Zod enum in `src/modules/listings/listings.schema.ts:5-35`), `cleaningFeeCents`, booking-mode settings (INSTANT/REQUEST, hold duration/limits — Phase 2), `depositPercent`, `defaultSecurityDepositCents`, a `houseRules` JSON blob, and workflow timestamps (`publishedAt`, `reviewedAt`, `reviewNote`).

### 2. Listing status state machine (draft → published)
`DRAFT → PENDING_REVIEW → APPROVED → PUBLISHED`, with `CHANGES_REQUESTED` as a side branch and `SUSPENDED` defined but never reachable (see Incomplete/stubs).
- Owner submits via `submitListingForReview` (`src/modules/listings/listings.service.ts:135-185`), which only allows the transition from `DRAFT`/`CHANGES_REQUESTED` and enforces concrete minimums: ≥1 photo, `descOverview` ≥50 chars, the other four description fields ≥20 chars, and ≥1 `Season` defined. All failures are collected and returned as a bulleted list, not fail-fast.
- Admin approves (`PENDING_REVIEW→APPROVED`) or requests changes (`PENDING_REVIEW→CHANGES_REQUESTED`, requires a non-empty note) via `src/modules/admin/admin.service.ts:18-93`; admin then separately publishes (`APPROVED→PUBLISHED`, stamps `publishedAt`). Any of these transitions throws if the property isn't in the exact expected status.
- Any subsequent owner edit of a `CHANGES_REQUESTED` listing silently resets status back to `DRAFT` (`listings.service.ts:118-122`), forcing re-submission.
- Public `/listings/[id]` page only ever resolves `PUBLISHED` properties (1-hour `unstable_cache`, tag `listing-{id}`+`properties`) — everything else 404s (`listings.service.ts:39-59`, `src/app/listings/[id]/page.tsx`).
- Admin review UI: `src/app/(admin)/admin/dashboard/properties/[id]/page.tsx` + `property-detail-actions.tsx` (Approve / Request Changes with required note / Publish / view-public-link buttons gated by current status).

### 3. Listing create/edit form (owner UI)
`src/components/forms/listing-form.tsx` is a client-side 8-step wizard (Basic Info → Location → Capacity → Descriptions → Photos → Amenities → House Rules → Review) backed by `createListing`/`updateListing` server actions. Notable concrete behavior:
- "Save as Draft" on a brand-new listing auto-fills placeholder text (`"Draft - overview pending"`, `"TBD"` for country/region/city/address, etc.) for any required field left blank, purely so the initial `createListingSchema` (which requires real min-lengths) doesn't reject the draft.
- Latitude/longitude are entered as raw number inputs — **no interactive map picker** exists anywhere in the owner form for setting a property's location; the Leaflet map (`src/components/map/property-map.tsx`) is read-only display, used only on the public listing page.
- Photo upload step is disabled until the listing has been saved once (needs a real `propertyId`).
- Amenities/house rules are held in local component state and only persisted when "Save as Draft" / "Submit for Review" is clicked (separate `setAmenities` action call; house rules travel inside the `updateListing` payload).
- Season pricing (`SeasonPricingForm`), extra fees (`ExtraFeeForm`), and staff services (`StaffServiceForm`) are **not** part of the wizard — they're separate cards rendered below it on the edit page only (`src/app/(owner)/owner/listings/[id]/page.tsx:96-136`), and only appear once the listing already exists.

### 4. Photo upload flow
Client → presigned R2 upload → server registration, in `src/components/gallery/photo-upload.tsx`:
1. Client validates type (jpeg/png/webp/avif/gif) and size (≤15MB) before upload.
2. `POST /api/upload/presign` (`src/app/api/upload/presign/route.ts`) requires a logged-in Supabase user and rate-limits by user ID (10/min), independently re-validates content-type/size server-side, and returns an R2 presigned PUT URL + public URL. **It does not check that the caller owns `propertyId`** — any authenticated user can obtain an upload URL scoped to any property ID they pass; ownership is only enforced later at `registerPhotoUpload` (`listingsService.addPhoto` → `verifyAccess`), which is the step that actually creates a `PropertyPhoto` row.
3. Client PUTs the file directly to R2, extracts image dimensions client-side (`Image.onload`), then calls `registerPhotoUpload` to create the DB record.
4. First photo uploaded is automatically the hero (`listingsQueries.addPhoto`, `sortOrder` = current max+1, `isHero = count===0`). Hero can be changed (`setHeroPhoto` unsets all others in a transaction), photos can be reordered (drag-free, up/down buttons rewriting `sortOrder` per array index) and deleted (with a confirm dialog).
5. Files: `src/components/gallery/photo-upload.tsx`, `src/app/api/upload/presign/route.ts`, `src/modules/listings/listings.{service,queries,actions,schema}.ts`.

### 5. Amenities
Fixed, hardcoded catalog of 21 amenities across 4 categories (outdoor/indoor/technology/wellness) — **not** user-extensible; the exact same catalog is duplicated verbatim in three files: `src/components/forms/amenity-selector.tsx` (owner editor, with free-text notes per amenity), `src/components/search/search-filter-panel.tsx` (search filter chips), and `src/shared/amenity-icons.ts` (icon/label lookup for cards & the public listing page). Saving amenities replaces the full set for a property (delete-not-in-new-set + upsert transaction, `listingsQueries.addAmenities`).

### 6. Seasonal pricing (`Season` model)
This is the actual dynamic-pricing mechanism — **there is no calendar-level custom pricing**, only date-range "seasons" with a flat per-night rate:
- Fields: name, start/end date, `pricePerNightCents`, `minimumStayNights` (1-90), `changeoverType` (`FLEXIBLE` = any day, or `FIXED` = specific `checkInDay`/`checkOutDay` 0-6 weekday). Zod (`seasonSchema`) requires `endDate > startDate` and, if `FIXED`, both changeover days present.
- **Overlap prevention**: server-side `listingsService.addSeason` (`src/modules/listings/listings.service.ts:204-230`) rejects any new season whose date range overlaps an existing one for that property (`s1 < e2 && s2 < e1` check), with a client-side pre-check duplicating the same logic in `season-pricing-form.tsx` for instant feedback before the round-trip.
- **`minimumStayNights` is purely informational** — it's shown in the calendar cell tooltip and the public pricing table, but it is never enforced by search (no min-nights filter) or by booking creation (grep of `bookings.service.ts` found no reference to it).
- Deleting a season has no dependency checks (no warning if bookings exist in that range).
- Files: `src/modules/listings/listings.{schema,types,service,queries}.ts`, `src/components/forms/season-pricing-form.tsx`.

### 7. Extra fees (`ExtraFee` model)
Simple line items: name, `amountCents`, `feeType` (`PER_BOOKING` / `PER_NIGHT` / `PER_GUEST`), `isOptional` (guest can decline). No overlap or uniqueness constraints — an owner can add duplicate/contradictory fees freely. CRUD is add/remove only (no edit-in-place). Displayed on both the public listing page and admin review page. Files: `src/components/forms/extra-fee-form.tsx`, `listings.{schema,service,queries,actions}.ts`.

### 8. Staff & services (`StaffService` model)
Name, optional description, `isIncluded` (bundled in base price) vs. extra cost (`extraCostCents`, only collected/shown when not included). Same add/remove-only CRUD pattern as extra fees. Files: `src/components/forms/staff-service-form.tsx`.

### 9. House rules
Stored as a single JSON blob on `Property.houseRules` (not a separate table): pets/smoking/events booleans, optional quiet-hours start/end (`HH:mm` strings, no actual time-format validation beyond the `<input type="time">`), and a free-form array of additional rule strings. Edited in-form (`house-rules-form.tsx`) and only actually persisted when the surrounding `updateListing` call fires (it's bundled into the `updateListingSchema.houseRules` field) — it has no dedicated server action of its own.

### 10. Cancellation policy — model exists, editing does not
`CancellationPolicy` (one-to-one with `Property`, `policyType` enum `FLEXIBLE`/`MODERATE`/`STRICT` with documented refund tiers in schema comments) is **read-only** throughout the codebase: `contracts.service.ts` and `payments.service.ts` both read `property.cancellationPolicy?.policyType ?? "MODERATE"` when generating contracts/computing refunds, but grepping the entire repo turns up no `.cancellationPolicy.create/update/upsert` anywhere and no form/action to set it. Every property is therefore permanently on the hardcoded `MODERATE` fallback in practice. See Incomplete/stubs.

### 11. Public listing detail page
`src/app/listings/[id]/page.tsx`: hero gallery, key stats, all 6 structured descriptions, staff/services, amenities grouped by category, house rules, sticky pricing card (cheapest season highlighted), Leaflet single-marker map, extra-fees table, and a full seasonal-pricing table. Emits `LodgingBusiness` JSON-LD for SEO. **No availability calendar is shown here** — a prospective agent cannot see which dates are blocked/booked on this page; the `AvailabilityCalendar` component is wired up only inside the owner's calendar-management route (confirmed by grep — it has exactly one importer app-side).

### 12. Availability calendar (owner-facing, `CalendarDay` states)
`CalendarDay` is a **sparse** table — a date only gets a row when it's not plain `AVAILABLE`; absence of a row = available (`calendarQueries.upsertDay` deletes the row when status is set back to `AVAILABLE` to keep it sparse). Statuses: `AVAILABLE` (implicit), `BOOKED`, `BLOCKED` (manual), `ICAL_BLOCKED` (external sync); `source` is `MANUAL`/`BOOKING`/`ICAL_SYNC`.
- `AvailabilityCalendar` (`src/components/calendar/availability-calendar.tsx`) renders a month grid with season-price overlay per day (via `calendarService.getMonthData`, which cross-references `Season` date ranges) and month navigation via server action (`getMonthData`) with a `useTransition`.
- **Only single-day toggle** is wired to UI: clicking an `available`/`blocked` cell calls `toggleDayBlock` with optimistic local update + rollback-refetch on failure (`calendar-day-cell.tsx`, `calendar.service.ts:108-142`). `BOOKED` and `ICAL_BLOCKED` days are explicitly non-toggleable (attempting throws server-side too, defense in depth).
- `blockDateRange`/`openDateRange` (bulk range block/unblock, with an optional note) are fully implemented at the service+action+schema layer (`calendar.service.ts:147-175`, `calendar.actions.ts`) but **have no UI caller anywhere** — grep across `src/components` and `src/app` found zero references. Backend-only feature.
- Non-owner viewers only ever see a collapsed 3-state (`available`/`booked`/`blocked`) — `mapStatus()` in `calendar.service.ts` merges `BLOCKED`+`ICAL_BLOCKED` and hides the `source` distinction from the public API surface, though in practice the calendar component itself is never rendered for non-owners (see #11).
- Files: `src/modules/calendar/calendar.{types,schema,service,queries,actions}.ts`, `src/components/calendar/{availability-calendar,calendar-day-cell,serialize-month-data}.tsx`.

### 13. iCal export
Public, unauthenticated `GET /api/ical/[propertyId]` (`src/app/api/ical/[propertyId]/route.ts`) returns a valid RFC 5545 `.ics` (via `ical.js`), rate-limited 30/min by IP, UUID-format-validated, 404s for unknown properties, 5-minute `Cache-Control`. `icalExportService.generateFeed` (`src/modules/calendar/ical-export.service.ts`) pulls every non-`AVAILABLE` `CalendarDay`, **merges consecutive same-status days into a single VEVENT** (not one event per day), labels each `Booked - {name}` or `Blocked - {name}`, and sets `DTEND` = last day + 1 (correct exclusive-end iCal semantics). Owner sees the shareable URL on the calendar page with a copy button (`copy-url-button.tsx`).

### 14. iCal import + conflict detection
- Owner adds a feed (name + URL) via `ICalFeedManager` → `addICalFeed` → `icalImportService.addFeed` (`src/modules/calendar/ical-import.service.ts`), which validates the URL against SSRF (blocks localhost/loopback/link-local metadata endpoint `169.254.169.254`/`metadata.google.internal`/private RFC1918 ranges/`.internal`/`.local`/`.localhost` TLDs, HTTP(S)-only) and immediately triggers a first sync (failure here is swallowed — feed is still created, cron will retry).
- `syncFeed` (core logic, `ical-import.service.ts:185-425`) parses VEVENTs via `node-ical`, expands each into individual dates, and classifies each date as **safe** (create/refresh an `ICAL_BLOCKED` row, `source: ICAL_SYNC`, `note` encodes `ical-feed:{feedId}|{summary}` — this note field doubles as the only linkage between a blocked day and its originating feed) or **conflicting** (an existing non-`ICAL_SYNC` row already occupies that date, i.e. it collides with a manual block or a real booking) — conflicting dates are grouped by event and written to `ICalConflict` instead of silently overwriting the existing block.
- Stale-import cleanup: any `ICAL_BLOCKED`/`ICAL_SYNC` day previously written by this feed but absent from the current fetch is deleted (handles the external platform removing a booking).
- Conflict resolution (`resolveConflict`, "block" vs "ignore") is owner-driven from the calendar page; "block" force-creates `ICAL_BLOCKED` rows for the conflicting range and marks the conflict resolved, "ignore" just marks it resolved without touching the calendar.
- Removing a feed deletes its `ICAL_BLOCKED` rows (matched by the `note` prefix trick above), its unresolved conflicts, then hard-deletes the feed row.
- Scheduled sync: real Inngest cron `*/15 * * * *` (`src/jobs/ical-sync.job.ts`), each feed synced in its own retryable step so one failing feed doesn't block others; manual "Sync Now" button also available per feed.
- Files: `src/modules/calendar/{ical-import.service,ical-import.actions,ical-import.schema,ical-export.service}.ts`, `src/app/api/v1/calendar/[propertyId]/ical/route.ts` (a second, REST-style add/list-feeds endpoint that duplicates some of the server-action functionality), `src/jobs/ical-sync.job.ts`, `src/components/calendar/{ical-feed-manager,ical-sync-status}.tsx`.

### 15. Search & discovery
Search page: `src/app/(agent)/agent/search/page.tsx`, filters UI `src/components/search/search-filters.tsx` (desktop) / `search-filters-mobile.tsx`, URL-state managed by `nuqs` (`searchParamsParsers`/`searchParamsCache`, `src/modules/search/search.schema.ts`).
- **Filters actually applied** (`searchQueries.buildWhereClause`, `src/modules/search/search.queries.ts:9-72`): `status: PUBLISHED` always; exact `country`, case-insensitive-contains `region`/`city`; `guests`/`bedrooms` as `gte` thresholds; price range as `some season in [min,max]` (matches if **any** season falls in range, not that all seasons do); **amenities filter uses OR semantics** — `amenities: { some: { amenityKey: { in: [...] } } }` matches a property that has **at least one** of the selected amenities, not all of them (a UI showing checked chips for "Pool" + "Gym" will surface properties with either, not both); date-range availability excludes any property with a `BOOKED`/`BLOCKED`/`ICAL_BLOCKED` `CalendarDay` anywhere inside `[checkIn, checkOut]`.
- **No minimum-stay validation** — a property whose season requires a 7-night minimum will still match a 2-night search.
- **Ranking**: there isn't any — results are `orderBy: { updatedAt: "desc" }` only (most-recently-updated-first). No relevance score, no distance sort, no price sort, and the UI exposes no sort control at all.
- Pricing computation (`searchService`, `src/modules/search/search.service.ts`): `lowestPricePerNight` = cheapest season's rate; `totalStayPrice` (only when both dates given) walks each night in `[checkIn, checkOut)` via `eachDayOfInterval`, finds the covering season for that specific night, falls back to the lowest season rate for any night with no covering season, and sums with `Decimal` (no float drift). Whole search response cached 5 min via `unstable_cache` (tag `"properties"`), keyed by a JSON-serialized, sorted-amenities filter object.
- `isAvailable` field on `SearchResult` is hardcoded `true` for every returned row — meaningless as a per-result signal since the where-clause has already excluded unavailable properties (or skipped the check entirely when no dates given).
- Pagination bug: `Pagination` component in `agent/search/page.tsx:113` builds page links as `href={`?page=${page}`}` — this **drops every other active filter** (country, dates, guests, price, amenities) when a user clicks to page 2+.
- Both `searchProperties` and `getMapMarkers` server actions (`src/modules/search/search.actions.ts`) have **no auth check** at all (they don't call `getAuthContext`/`createAction`) — access control is only via the `(agent)` route-group layout gating the page itself; the actions, if called directly, would return published-listing data to anyone.
- No automated tests exist for the search, calendar, or listings modules (unlike `bookings`/`payments`/`messaging`, which have `__tests__` directories).

### 16. Map integration
Two independent Leaflet (`react-leaflet` + OpenStreetMap tiles, not Google Maps/Mapbox) integrations, both client-only and dynamically imported with `ssr:false`:
- **Single-property map** (`src/components/map/property-map.tsx`, lazy-wrapped in `property-map-lazy.tsx`): fixed marker + popup on the public listing page. Manually patches Leaflet's default marker icon URLs (a known bundler quirk) by pointing at `unpkg.com` CDN images at runtime.
- **Search results map** (`src/components/search/search-map.tsx`): custom `DivIcon` price-tag markers, `react-leaflet-cluster` marker clustering, auto-fit-bounds to visible markers, popups showing a mini property card (photo/name/price/"View Details" link) built from a `Map` lookup joining marker data to full search results. Defaults to a Mediterranean-centered view (`[38.0, 20.0]`, zoom 4) when there are no markers, reflecting the product's luxury-villa target geography.
- No geocoding/reverse-geocoding anywhere — lat/lng are hand-entered numbers in the owner form (see #3) with zero relation to the `address`/`city` text fields (they can be arbitrarily inconsistent).

### Incomplete/stubs

- **`CancellationPolicy` model has no create/update path anywhere in the codebase.** It's defined in the schema, included in Prisma queries by `contracts`/`payments` modules, and defaulted to `"MODERATE"` when null — but there is no owner-facing UI, server action, or service method to actually set a property's policy tier. Every property is permanently on the fallback.
- **`Property.cleaningFeeCents`** is read and displayed (public listing page, booking pricing calculator, contracts) but is absent from `createListingSchema`/`updateListingSchema` and the listing form — there is no way for an owner to set it above its `0` default through the UI.
- **`PropertyStatus.SUSPENDED`** is a defined enum value with a UI label (`property-status.ts`) but no code path anywhere transitions a property into it — unreachable state.
- **`blockDateRange`/`openDateRange`** (bulk date-range block/unblock on the calendar) are fully implemented end-to-end at the schema/service/action layer (`calendar.schema.ts`, `calendar.service.ts`, `calendar.actions.ts`) but have zero UI callers — only single-day toggling is exposed to owners.
- **No availability calendar is ever shown to agents or the public** — `AvailabilityCalendar` is imported only by the owner's `/owner/listings/[id]/calendar` route; the public `/listings/[id]` page shows season pricing tables but no day-level availability.
- **Search "amenities" filter is OR, not AND** — selecting multiple amenity chips widens rather than narrows results, which is likely to surprise users expecting an AND filter (not flagged anywhere in the UI copy).
- **`minimumStayNights`** on a `Season` is decorative only — it is displayed in the calendar tooltip and public pricing table but never enforced by search filtering or by booking creation.
- **Search pagination drops filters** — `?page=${page}` links in `agent/search/page.tsx` discard all other active query params (dates, location, price, amenities) when navigating past page 1.
- **`searchProperties`/`getMapMarkers` server actions have no authentication check**, relying entirely on the `(agent)` layout's page-level `requireRole` gate; called directly they'd serve published-listing data to anyone unauthenticated.
- **Photo-upload presign endpoint (`/api/upload/presign`) doesn't verify the caller owns the target `propertyId`** — it only requires the caller be authenticated; ownership is enforced one step later, at photo *registration* (`registerPhotoUpload`), not at URL-issuance time.
- **Listing/calendar mutation server actions carry no `role` restriction** (`createListing`, `updateListing`, `addSeason`, `toggleDayBlock`, etc. never pass `role:` to `createAction`) — any authenticated user of any role can call them; protection is solely via UI route gating plus per-object `ownerId` ownership checks inside each service method.
- No automated test coverage for the `listings`, `search`, or `calendar` modules (contrast with `bookings`, `payments`, `messaging`, which have `__tests__`).
- A second, thinner iCal-feed REST endpoint exists at `src/app/api/v1/calendar/[propertyId]/ical/route.ts` (GET list / POST add) alongside the server-action-based flow used by the actual UI — duplicate surface area, unclear if intentionally public API vs. dead code (no client references it in `src/app`/`src/components`).

**Key files for this area:** `src/modules/listings/*`, `src/modules/search/*`, `src/modules/calendar/*`, `prisma/schema.prisma`, `src/app/(owner)/owner/listings/**`, `src/app/(admin)/admin/dashboard/properties/**`, `src/app/listings/[id]/page.tsx`, `src/app/(agent)/agent/search/page.tsx`, `src/components/{forms,gallery,calendar,map,search}/*`, `src/jobs/ical-sync.job.ts`.

---

## Bookings, Contracts & Deposits

### Booking state machine

The canonical state machine lives in `src/modules/bookings/bookings.types.ts` as `VALID_TRANSITIONS`, an 8-state map used only by the generic `bookingsService.transitionState()` method:

```
REQUESTED  -> APPROVED, CANCELLED, EXPIRED
APPROVED   -> CONTRACTED, CANCELLED, EXPIRED
CONTRACTED -> PAID, CANCELLED, EXPIRED, APPROVED   (APPROVED = contract declined, reverts)
PAID       -> CONFIRMED
CONFIRMED  -> COMPLETED, CANCELLED
COMPLETED / CANCELLED / EXPIRED -> (terminal)
```

Important structural detail: **there are two separate enforcement mechanisms that don't fully agree with each other.**
1. `transitionState(bookingId, newStatus, userId)` (`src/modules/bookings/bookings.service.ts:427`) consults `VALID_TRANSITIONS` and is used exclusively by system/webhook-driven code — never exposed as a user-facing server action. Callers: `contract-signing-flow.job.ts` (→ CONTRACTED), `contracts.service.ts` `handleContractDeclined` (→ APPROVED, on decline), `payments.service.ts` (→ PAID, then → CONFIRMED), `booking-completion.job.ts` (→ COMPLETED).
2. `approveBooking`, `declineBooking`, `cancelBooking`, `expireBooking` each hard-code their own allowed "from" statuses inline and do **not** consult `VALID_TRANSITIONS` at all. This causes a real divergence: `VALID_TRANSITIONS.CONFIRMED` declares `CONFIRMED -> CANCELLED` as valid, but `cancelBooking`'s own `cancellableStatuses` array is `["REQUESTED", "APPROVED", "CONTRACTED"]` — CONFIRMED is not included, and no other code path ever calls `transitionState(id, "CANCELLED", ...)`. **A CONFIRMED (i.e. paid) booking can never be cancelled through any code path in the app** — see "Incomplete/stubs" for the full implication.

Each transition updates a matching timestamp column (`approvedAt`, `contractedAt`, `paidAt`, `confirmedAt`, `completedAt`, `cancelledAt`, `expiredAt`) via `getStatusTimestamp()` in `bookings.queries.ts`. All status writes use Prisma optimistic locking (`where: { id, status: currentStatus }`) — if the row's status has changed since it was read, Prisma throws `P2025`, which is caught and rethrown as `"Booking state has changed, please refresh"`.

### Request-based vs. instant-book flow

Both flows share one `createBooking()` (`bookings.service.ts:28`). The property's `bookingMode` (`INSTANT` | `REQUEST`) decides the initial status:
- **REQUEST**: booking created as `REQUESTED`. An Inngest `booking/requested` event fires `booking-request-timeout.job.ts`, which auto-expires the booking after **72 hours** (hard-coded, not configurable per property) if the owner never approves.
- **INSTANT**: booking created directly as `APPROVED` — it skips `REQUESTED` entirely and `booking/approved` is emitted directly from `createBooking`. This triggers the same downstream jobs a manually-approved request would (`contract-signing-flow.job.ts`, `contract-reminders.job.ts`, `booking-hold-timeout.job.ts`).

For instant-book, `maxHoldsPerAgent` is checked in `createBooking()` itself (counts existing `APPROVED` bookings for that agent/property). For request-based, the same check happens again inside `approveBooking()` at the moment the owner approves (both check `bookingsQueries.countActiveHoldsByAgent`).

`holdExpiresAt` (the payment window) is set from `property.holdDurationHours` (schema default 48h) at whichever point the booking reaches APPROVED — either at creation (instant) or at approval (request). `HoldCountdown` (`src/components/bookings/hold-countdown.tsx`) renders a live countdown with green/amber/red thresholds at >12h / 6–12h / <6h remaining. `booking-hold-timeout.job.ts` races a `booking/paid` event against this timeout; if it fires without payment **and** no contract is actively `SENT`/`PARTIALLY_SIGNED` (which has its own 7-day timeout), it auto-expires the booking via `bookingsService.expireBooking()`.

Pricing is computed identically for both flows by `calculatePricing()` (bottom of `bookings.service.ts`): walks each night with `date-fns`, finds the covering `Season` by date range (falls back to the cheapest season's rate if no season matches), sums via `Decimal.js`, and adds the cleaning fee plus any non-optional `extraFees` (`PER_NIGHT` fees multiplied by night count, others flat). The client-side `booking-form.tsx` duplicates this exact calculation for a live preview but the server always recomputes independently — the client math is display-only.

### Approve / Decline / Cancel / Expire — permissions and conditions

All in `src/modules/bookings/bookings.service.ts`, gated by `"use server"` actions in `bookings.actions.ts` that resolve `ctx.userProfileId` from session:

- **`approveBooking(bookingId, userId, ownerNotes?)`** — only `booking.property.ownerId === userId` may call it (throws `"Only the property owner can approve bookings"` otherwise). REQUESTED → APPROVED only. Re-checks `maxHoldsPerAgent`. **This is also the only place a `SecurityDeposit` row gets created** — see the Security Deposits section and the instant-book gap noted below.
- **`declineBooking(bookingId, userId, reason)`** — owner-only, REQUESTED → CANCELLED. `reason` is required by `declineBookingSchema` (`z.string().min(1, ...)`). Releases held `CalendarDay` rows.
- **`cancelBooking(bookingId, userId, reason?)`** — either `booking.agentId === userId` or `booking.property.ownerId === userId` (not admin, not client). Allowed only from `REQUESTED`, `APPROVED`, or `CONTRACTED` — attempting on `PAID`/`CONFIRMED`/terminal states throws `"Cannot cancel a booking with status X. Cancellation is only allowed before payment."`. If the booking is `CONTRACTED`, it first calls `contractsService.voidContract()` to void the live DocuSign envelope (so stale signing links stop working) *before* updating the booking row — the two operations are not wrapped in a shared DB transaction, so a failure between them (DocuSign void succeeds, booking update fails) can leave a voided contract on a still-CONTRACTED booking.
- **`expireBooking(bookingId)`** — system-only (no `userId`/permission check at all; called by Inngest jobs). Only from `APPROVED` or `REQUESTED`.
- Both `cancelBooking` and `declineBooking`/`expireBooking` call `bookingsQueries.releaseDates()`, which deletes `CalendarDay` rows matched by `note.startsWith('booking:<id>')` — a string-prefix match rather than a foreign key, functional but fragile.

Refunds for already-paid bookings go through a **completely separate** path, `paymentsService.processRefund()` (`src/modules/payments/payments.service.ts:355`), callable by the booking's agent or an admin via `initiateRefund` (`payments.actions.ts`). It calculates a refund by cancellation-policy tier and issues a Stripe refund + transfer reversals, but **never touches `Booking.status` or calendar days** — confirming the finding above that a CONFIRMED/PAID booking has no code path back to CANCELLED; a refunded booking stays "CONFIRMED" forever with its dates still blocked.

### DocuSign contract integration

**Generation** — `contractsService.generateContract(bookingId)` (`src/modules/contracts/contracts.service.ts:67`): loads the booking, refuses if a `Contract` already exists (one-to-one via unique `bookingId`), computes a `FinancialBreakdown` via `calculateBookingFinancials` (single source of truth, `src/modules/payments/financial-calculator.ts`), snapshots everything (property, dates, pricing, all three parties, cancellation-policy terms text, insurance figures) into an immutable `ContractData` JSON blob, renders it to PDF with `@react-pdf/renderer` (`templates/booking-contract.tsx`), uploads the draft to R2 at `contracts/<bookingId>/draft.pdf`, and creates the `Contract` row as `DRAFT` with a 24h presigned draft URL.

**Sending** — `sendForSigning(contractId)`: only from `DRAFT`. Builds a three-signer DocuSign envelope (`docusign.adapter.ts`):
- **Client**: `routingOrder: 1`, email/remote signing (no `clientUserId`) — DocuSign emails them directly; the app has no client-facing signing UI.
- **Agent**: `routingOrder: 2`, embedded (`clientUserId = booking.agent.id`).
- **Owner**: `routingOrder: 3`, embedded (`clientUserId = booking.property.owner.id`).

Signature/date tabs are placed via anchor-string matching (`/sig_client/`, `/sig_agent/`, `/sig_owner/`) baked into the PDF template, not fixed coordinates. Because routing orders differ, DocuSign's default sequential-signing behavior applies (no parallel-signing override is set) — practically, the agent and owner cannot access their embedded signing session until the client has signed by email. A per-envelope `eventNotification` webhook (not the global DocuSign Connect config) points at `/api/webhooks/docusign` and subscribes to `completed`/`declined`/`voided` at both envelope and recipient level. Contract status flips `DRAFT -> SENT` on send.

**Embedded signing URLs** — `getEmbeddedSigningUrl(contractId, "agent"|"owner", returnUrl)`: resolves signer role by matching `ctx.userProfileId` against `booking.agentId`/`property.ownerId` in `contracts.actions.ts::getSigningUrl`, then calls DocuSign's `createRecipientView` with `authenticationMethod: "none"` — DocuSign performs no independent identity check; trust is entirely delegated to the app's own session auth.

**Webhook handling** — `src/app/api/webhooks/docusign/route.ts`: IP rate-limited (100/min), optional HMAC-SHA256 verification (`x-docusign-signature-1` header) via `DOCUSIGN_WEBHOOK_HMAC_KEY` — **required and enforced in production** (rejects all webhooks if the key isn't configured), permissive in dev. Idempotency is enforced via a shared `ProcessedWebhookEvent` table keyed by a synthesized `envelopeId-eventType-recipientId-timestamp` string. Always returns HTTP 200 (even on internal errors) to stop DocuSign retries. Three event types handled:
- `recipient-completed` → `contractsService.handleSignerComplete()`: matches the signer's email against client/agent/owner emails, stamps the relevant `*SignedAt` field, flips contract `SENT -> PARTIALLY_SIGNED` on first signer, and once all three timestamps are set, calls `completeContract()` (downloads the signed PDF from DocuSign, stores it at `contracts/<bookingId>/signed.pdf` in R2, sets contract `COMPLETED`, emits `contract/all-signed`).
- `recipient-declined` → `contractsService.handleContractDeclined()`: sets contract `DECLINED`, records who declined (client has no `UserProfile`, so `declinedBy` stays `undefined` for client declines) and why, and — if the booking is still `CONTRACTED` — reverts it to `APPROVED` via `transitionState` and resets `holdExpiresAt` so the agent gets a fresh payment window to re-initiate. Also fires in-app `CONTRACT_DECLINED` notifications to both agent and owner.
- `envelope-completed` — fallback/safety net: if the contract isn't already `COMPLETED`, replays `handleSignerComplete` for every signer marked completed in the payload.

`contract-signing-flow.job.ts` (Inngest) is what actually moves the booking to `CONTRACTED`: triggered on `booking/approved`, it generates+sends the contract, then `step.waitForEvent("contract/all-signed", timeout: "7d")`. All-signed within 7 days → `transitionState(bookingId, "CONTRACTED", "system")`. Timeout → marks any still-`SENT`/`PARTIALLY_SIGNED` contract `EXPIRED` and expires the booking. `contract-reminders.job.ts` runs in parallel sending in-app reminders at 24h, 48h, then daily up to day 7 (client is never reminded in-app since they sign by email only).

**Voiding** — `voidContract(bookingId, reason)`: only acts if the contract is `SENT` or `PARTIALLY_SIGNED` (no-ops for `DRAFT`/`COMPLETED`/`DECLINED`); calls DocuSign `voidEnvelope` and sets contract `VOIDED`. Invoked from `bookingsService.cancelBooking()` when cancelling a `CONTRACTED` booking.

**UI** — `src/components/contracts/contract-signing-panel.tsx` shows per-signer status, a "Sign Contract" button (redirects to the embedded DocuSign URL) gated on `SENT`/`PARTIALLY_SIGNED` and the current user not yet having signed, a draft-download button, and a signed-download button once `COMPLETED`. Downloads go through `getContractDownloadUrl` (1h presigned R2 URL), access-gated to agent/owner/admin.

### Security deposits

**State machine** (`src/modules/deposits/deposits.types.ts`, `DEPOSIT_TRANSITIONS`):
```
PENDING -> CHARGED -> HELD -> {RELEASING -> RELEASED} | {CLAIM_HOLD -> DEDUCTED | RELEASED}
```
All transitions in `deposits.service.ts` are validated against this map and written with optimistic locking (`where: { id, status: fromStatus }` in `deposits.queries.ts`) — but note `updateDepositStatus` there has **no P2025 catch/remap** (unlike bookings/contracts), so a lost race surfaces as a raw Prisma error rather than a friendly message.

- **Create** — `createDeposit(bookingId, amountCents, currency)`: only called from `bookingsService.approveBooking()`, and only `if (booking.property.defaultSecurityDepositCents > 0)`. Rejects `amountCents <= 0`.
- **Adjust** — `adjustDepositAmount()`: owner-only action (`deposits.actions.ts::adjustDepositAction`, verifies `role === "OWNER"` and property ownership), only while `status === "PENDING"` (i.e., before the client has paid it). Updates both `SecurityDeposit.amountCents` and `Booking.securityDepositCents` in one `$transaction`.
- **Charge** — `chargeDeposit(depositId)`: only from `PENDING`; creates a **separate** Stripe `PaymentIntent` tagged `metadata.paymentType = "security_deposit"` with no `transfer_data` (funds stay on-platform, not split to owner/agent like booking payments). Invoked from `POST /api/checkout/[bookingId]/create-deposit-intent` on the public checkout page.
- **On charged** — `onDepositCharged(depositId, stripeChargeId)`: transitions `PENDING -> CHARGED`, sets `chargedAt`, emits `deposit/charged` (which `trust-safety-notifications.job.ts::onDepositCharged` listens for, to notify the agent). **See Incomplete/stubs — this method is never actually invoked anywhere in the app.**
- **Hold** — `holdDeposit(bookingId)`: `CHARGED -> HELD`, sets `holdExpiresAt = checkOut + 7 days`. Called from `deposit-release.job.ts` on `booking/completed`.
- **Release (no claim)** — `releaseDeposit(bookingId)`: `HELD -> RELEASING -> RELEASED`, issues a full Stripe refund, emits `deposit/released`. Triggered by `deposit-release.job.ts` after `step.waitForEvent("claim/filed", timeout: "7d")` times out with no claim.
- **Hold for claim** — `holdForClaim(bookingId)`: `HELD -> CLAIM_HOLD`, invoked when a `claim/filed` event lands inside the 7-day window (claim-filing UI itself lives in `src/modules/claims/`, out of this area's scope, but it calls back into `deposits.service.ts::deductFromDeposit` / `releaseAfterClaimDismissed`).
- **Deduct** — `deductFromDeposit(bookingId, deductionCents)`: `CLAIM_HOLD -> DEDUCTED`, rejects `deductionCents > amountCents`, issues a partial Stripe refund for the remainder if any, emits `deposit/deducted`.
- **Dismiss claim** — `releaseAfterClaimDismissed(bookingId)`: `CLAIM_HOLD -> RELEASED`, full refund. Note: its guard `validateTransition(deposit.status, "RELEASED")` is technically satisfied by *either* `CLAIM_HOLD` or `RELEASING` (both list `RELEASED` as a valid next state), but the call immediately after hard-codes the optimistic-lock `fromStatus` as `"CLAIM_HOLD"` — so if it were ever mis-called while a deposit was actually `RELEASING`, the DB update would simply fail to match rather than silently corrupting state. Loose validation, not an active bug given current callers.
- **Minimum claim threshold**: `MIN_CLAIM_AMOUNT_CENTS = 5000` (€50) is defined **independently in two places** — `deposits.types.ts` and `claims.types.ts` — duplicated rather than shared from one source.
- A fallback cron-style query, `depositsQueries.getDepositsForRelease()` (status `HELD` and `holdExpiresAt <= now`), exists but nothing in the audited directories calls it — release is driven purely by the Inngest `deposit-release.job.ts` timer, so this looks like dead/unused code (or a safety-net query intended for a reconciliation job that was never wired up).

**Checkout flow** — `src/app/checkout/[bookingId]/` is a public, token-authenticated page (no login): `GET /api/checkout/[bookingId]?token=...` validates a `Payment.checkoutToken`, checks expiry (`checkoutExpiresAt`, 48h from creation) and booking status (must be `APPROVED` or `CONTRACTED`), then returns booking/pricing/agent-branding data plus the linked `SecurityDeposit` (if any) fetched separately. `checkout-form.tsx` verifies the visitor's email matches `booking.guestEmail` (client-side gate only, not a security boundary — the token is the real auth) before rendering `CheckoutForm`. On mount it creates up to **two independent Stripe PaymentIntents**: the booking payment (deposit-of-total or balance, via `create-intent`) and, if a `PENDING` security deposit exists, a second intent via `create-deposit-intent`. The form confirms the booking payment first; if that succeeds it then confirms the deposit payment separately, and **explicitly treats deposit-confirmation failure as non-fatal** — the booking payment still counts as a success and the UI shows a "deposit will be retried separately" warning, with no actual retry mechanism visible in the audited code.

### Incomplete/stubs

- **Security deposit charge confirmation is never wired up server-side — deposits get stuck at `PENDING` forever, even when Stripe successfully charges the client.** `depositsService.onDepositCharged()` is the only code path that flips `PENDING -> CHARGED`, but nothing calls it. The Stripe webhook (`src/app/api/webhooks/stripe/route.ts`) routes `payment_intent.succeeded` through `paymentsService.processSuccessfulPayment()`, which looks the PaymentIntent up exclusively in the `Payment` table (`paymentsQueries.getPaymentByStripeId`). The security deposit's PaymentIntent ID is stored only on `SecurityDeposit.stripePaymentIntentId` (a separate table/model) — even though the intent is tagged `metadata.paymentType: "security_deposit"`, nothing in the webhook branches on that metadata. So for a deposit intent, `getPaymentByStripeId` returns `null`, `processSuccessfulPayment` throws `"Payment not found for PaymentIntent: ..."`, which is caught by the webhook's outer try/catch, logged to console, and the event is still marked processed (idempotent no-op). Net effect: the client's card is actually charged on Stripe, but the `SecurityDeposit` row never leaves `PENDING`. Downstream, `holdDeposit()` (called by `deposit-release.job.ts` on `booking/completed`) requires `CHARGED -> HELD`, which now always fails validation (`DEPOSIT_TRANSITIONS.PENDING` doesn't include `HELD`); the job catches this and simply returns `{status: "skipped"}`. The entire 7-day hold → auto-release → claim-window pipeline silently never runs for any deposit that went through checkout, and the `deposit/charged` notification (`trust-safety-notifications.job.ts::onDepositCharged`) never fires either. There is no test coverage in `src/modules/deposits/` or `src/modules/contracts/` (no `__tests__` directories exist for either module) that would have caught this.
- **Instant-book properties never get a `SecurityDeposit` record at all**, regardless of `property.defaultSecurityDepositCents`. Deposit creation logic exists only inside `bookingsService.approveBooking()` (`bookings.service.ts:234-249`), which is the manual owner-approval action for `REQUESTED` bookings. Instant-book bookings are created directly in `APPROVED` status by `createBooking()`, bypassing `approveBooking()` (and every caller of it — owner UI dialogs and one public API route — confirmed by grep) entirely. So an instant-book property configured to require a security deposit silently provides none; the checkout page will show no security deposit line item for these bookings.
- **The generated/signed contract PDF always discloses a security deposit of €0**, independent of the two bugs above. `contractsService.generateContract()` calls `calculateBookingFinancials()` without passing `securityDepositCents` (the parameter exists and defaults to `0` — `financial-calculator.ts`), so `financialBreakdown.securityDepositCents` is always `0`, and the contract snapshot's `securityDepositCents` field (`contracts.service.ts:136,196`) is always `0` regardless of what the owner actually configured or what the checkout page displays/charges. No caller anywhere in `payments` or `contracts` ever threads the real `booking.securityDepositCents` value into the financial calculator.
- **A CONFIRMED or PAID booking cannot be cancelled by anyone through any exposed code path**, even though `VALID_TRANSITIONS.CONFIRMED` declares `CANCELLED` a valid next state. `cancelBooking()`'s own `cancellableStatuses` list omits `CONFIRMED`/`PAID`, and no caller in the codebase ever invokes the generic `transitionState(id, "CANCELLED", ...)`. The only handling for paid bookings is `paymentsService.processRefund()` (agent/admin-triggered), which refunds money via Stripe but never updates `Booking.status` or releases `CalendarDay` rows — a refunded booking stays `CONFIRMED` forever with its dates still blocked on the calendar.
- The `checkout` GET response includes a `pricing.securityDepositCents` field (also always `0`, same root cause as above) that appears unused by the checkout page's render logic, which instead reads the separately-fetched `securityDeposit` object — likely dead/vestigial data in the API response.
- `depositsQueries.getDepositsForRelease()` (a "find deposits past their hold expiry" query, presumably meant as a cron safety net) exists but has no caller anywhere in the codebase.

**Key files**: `src/modules/bookings/{bookings.service.ts,bookings.queries.ts,bookings.types.ts,bookings.schema.ts,bookings.actions.ts}`, `src/modules/contracts/{contracts.service.ts,contracts.queries.ts,contracts.types.ts,contracts.schema.ts,contracts.actions.ts,docusign.adapter.ts,templates/booking-contract.tsx}`, `src/modules/deposits/{deposits.service.ts,deposits.queries.ts,deposits.types.ts,deposits.actions.ts}`, `src/app/checkout/[bookingId]/{page.tsx,checkout-form.tsx,layout.tsx}`, `src/app/api/checkout/[bookingId]/{route.ts,create-intent/route.ts,create-deposit-intent/route.ts}`, `src/app/api/webhooks/{docusign/route.ts,stripe/route.ts}`, `src/jobs/{contract-signing-flow.job.ts,contract-reminders.job.ts,booking-hold-timeout.job.ts,booking-request-timeout.job.ts,booking-completion.job.ts,deposit-release.job.ts}`, `src/modules/payments/payments.service.ts` (cross-referenced for the PAID/CONFIRMED transition trigger and the refund gap), `src/components/bookings/*`, `src/components/contracts/contract-signing-panel.tsx`.

---

## Payments, Billing, Insurance & Claims

### Stripe payment integration (checkout, PaymentIntents, webhooks)

NexLet uses **Stripe Connect Express accounts** with **Separate Charges and Transfers** (not Destination Charges), because a single booking payment must ultimately be split three ways — owner, agent, platform.

- **Charge side**: `src/modules/payments/stripe-connect.adapter.ts` creates a plain `PaymentIntent` on the platform's own Stripe account (`transfer_group: booking_{bookingId}`) for the DEPOSIT/BALANCE, and a **separate** PaymentIntent for the refundable security deposit that intentionally has no `transfer_data` so funds stay on the platform balance (`createSecurityDepositIntent`).
- **Client checkout UI** (`src/app/checkout/[bookingId]/checkout-form.tsx`) uses Stripe Elements' `PaymentElement` + `stripe.confirmPayment` for the booking payment, then — if a security deposit is pending — separately calls `stripe.confirmCardPayment(depositClientSecret)` with **no payment-method argument**. Because the deposit PaymentIntent is a distinct Stripe object with nothing attached to it, this call has no card/payment-method to confirm with; the UI simply catches the failure and shows "will be retried separately," but no retry job exists anywhere in the codebase (`src/jobs/` has no deposit-retry job). This looks like the security-deposit charge on the standard checkout path does not actually work end-to-end.
- **Bank transfer / invoicing**: `stripeConnectAdapter.createInvoice` uses Stripe Invoicing with `customer_balance` / `eu_bank_transfer` (hardcoded to NL) — a real, distinct payment path from card checkout.
- **Webhook handler** (`src/app/api/webhooks/stripe/route.ts`): verifies signature via `stripe.webhooks.constructEvent`, rate-limits by IP (100/min), and is **idempotent** via a `ProcessedWebhookEvent` table keyed on Stripe's event ID (checked before processing, recorded after — even on handler errors, to avoid infinite retries). Always returns HTTP 200. Handles: `payment_intent.succeeded/payment_failed`, `transfer.created/reversed` (updates `PaymentSplit.status`), `account.updated` (syncs `payoutsEnabled`), `invoice.paid/payment_failed` (bank transfer). **`customer.subscription.*` events are explicitly no-op'd** — see Billing section below, this is a real gap.
- **Onboarding**: Express accounts via `stripeConnectAdapter.createConnectedAccount` + hosted `accountLinks` onboarding + Express Dashboard login links. Both owners and agents store their connected-account ID in the same `AgentSubscription` table (an implementation detail explicitly called out in `payments.queries.ts` comments — owners "borrow" the agent subscription table to hold a Connect account ID, there's no dedicated owner-billing table).

### PaymentSplit / commission / payout computation

**Single source of truth**: `src/modules/payments/financial-calculator.ts::calculateBookingFinancials`. Uses `decimal.js` exclusively with integer cents — no floats anywhere, comment explicitly forbids any other module computing money.

Concrete math:
- **Agent markup**: `PERCENTAGE` type multiplies each night's base price by `1 + value/10000` (value is percent×100, e.g. 1000 = 10%) and floors per night; `FLAT` type divides the flat cents evenly across nights with the **remainder dumped onto the last night** (`perNight = floor(flat/nights)`, `remainder = flat - perNight*nights`).
- **Client total** = client subtotal (with markup) + cleaning fee + extra fees + insurance premium. Security deposit is explicitly *not* included (separate Stripe charge).
- **Platform commission** = `floor(clientTotal * commissionPercent / 100)`. **Agent's commission share** = `floor(platformCommission * agentCommissionPercent / 100)`. **Platform keeps** the remainder (`platformCommission - agentCommission`, exact, no further rounding). **Agent total earnings** = markup + agent's commission share. **Owner net payout** = `clientTotal - platformCommission - markup` (exact subtraction — the owner absorbs/benefits from all `floor()` rounding loss, since both commission and its agent-share are always rounded down).
- A `totalSplitVerification` boolean asserts `owner + agent + platform === clientTotal`; **it is computed but never read, logged, or asserted against anywhere else in the codebase** — a silent sanity check with no consumer.
- **Deposit/balance split**: if check-in is `<30 days away` (`DEFAULT_BALANCE_DAYS_BEFORE`), full payment is required upfront. Otherwise `deposit = floor((clientTotal - insurancePremium) * depositPercent/100) + insurancePremium` (insurance is always collected with the first payment), `balance = clientTotal - deposit`.
- **`PaymentSplit` records** (owner/agent/platform, accounting only) are created in `payments.service.ts::processSuccessfulPayment`, prorated per payment by `paymentRatio = payment.amountCents / clientTotalCents`. Explicitly documented as accounting-only — actual money movement happens later, via Inngest.

**Actual Stripe transfers** happen in `src/jobs/payout-processing.job.ts`, triggered on `booking/confirmed` (i.e. once the balance is fully paid — see state machine below):
- Only the **balance-portion share** of `ownerNetPayoutCents` is transferred to the owner's Connect account (`sourceTransaction` = the balance charge). The deposit portion is described in comments as "held for damage protection until after checkout."
- The agent receives their **full `agentTotalEarningsCents`** (markup + commission share) in one transfer at the same moment — not prorated, unlike the owner.
- Both transfers are best-effort: if the owner/agent hasn't finished Stripe Connect onboarding (`payoutsEnabled`/`chargesEnabled` false), the job records a skip reason and does not throw; there's no code found anywhere that retries these skipped transfers later.
- **A real, verified gap**: nothing in the codebase ever transfers the owner's *deposit-portion* share out to their Connect account. `depositReleaseFlow` (triggered on `booking/completed`) only manages the **SecurityDeposit** (damage deposit) lifecycle, refunding it back to the *guest*, not paying out to the owner. Grepping every `stripeConnectAdapter.createTransfer` call site in the repo turns up exactly two calls (owner-balance, agent-total) — the owner's deposit-installment money appears to remain stranded on the platform Stripe balance indefinitely.

`Payout` DB records (`payments.queries.ts::createPayout`) are only created for the owner's balance-portion transfer, mirroring the above.

### Cancellation / refunds

Two refund calculators exist in `financial-calculator.ts`:
- `calculateRefundAmount` — tiered cancellation policy (FLEXIBLE/MODERATE/STRICT with 100%/50%/0% thresholds at day cutoffs) — this is the one actually wired up, used by `paymentsService.processRefund` (which is called from `initiateRefund` action and from the balance-grace-period auto-cancel flow).
- `calculateSimplifiedRefund` — doc comment says it's the new Phase-4 policy ("owner cancels = full refund, client cancels = none") but grepping the whole codebase shows it is **only referenced by its own unit test** — dead code, never called from any service or action.

`processRefund` creates a Stripe refund and then walks `payment.splits`, reversing any `TRANSFERRED` transfers proportionally (`stripe.reverseTransfer`) — failures there are caught and logged but don't fail the refund itself.

### Balance collection & grace period (`src/jobs/balance-collection.job.ts`)

Cron (daily 09:00 UTC) finds PENDING balance payments due within 30 days and sends payment links once (`remindersSent` gate). A second cron pass finds payments past due with the initial link sent and fires `payment/balance-due`, which drives an event-driven flow: day-1 reminder → wait 2d → day-3 urgent → wait 2d → day-5 final warning → wait 1d → day-6 auto-cancel (via `bookingsService.cancelBooking`) + deposit refund. Uses `step.waitForEvent` against `payment/balance-paid` at each stage to bail out early if paid.

### Booking state machine & when money actually moves

`VALID_TRANSITIONS` (`src/modules/bookings/bookings.types.ts`): `REQUESTED → APPROVED → CONTRACTED → PAID → CONFIRMED → COMPLETED`. Paying the deposit alone does **not** move the booking to PAID unless `balanceCents === 0`; normally the booking sits in CONTRACTED until the balance is paid, at which point `processSuccessfulPayment` transitions it straight to PAID then immediately auto-transitions to CONFIRMED in the same call (triggering payout, insurance activation jobs off `booking/confirmed`).

### Currency / rounding

All money is integer cents, computed exclusively via `decimal.js` with explicit `.floor()` at every split point (never round-to-nearest or ceil) — confirmed consistently across `financial-calculator.ts`, `deposits.service.ts`, `payout-processing.job.ts`. No in-app FX conversion exists; a comment in `payout-processing.job.ts` states transfers happen in the booking's currency and "Stripe handles conversion at mid-market rate + ~1%" if the connected account's bank is in a different currency — this is entirely delegated to Stripe, not implemented in-app. `src/shared/money/currency.ts` provides display helpers (`centsToDisplay`, `centsToPlainDisplay`, `centsToWholeDisplay`, `displayToCents`) all Decimal-backed.

**Confirmed inconsistency**: `agentCommissionPercent` (agent's cut of platform commission) is hardcoded to two *different* values in two places that both call `calculateBookingFinancials`: `contracts.service.ts` uses `DEFAULT_AGENT_COMMISSION_PERCENT = 30` when generating the contract PDF the three parties sign, but that computed breakdown is **never persisted** to `booking.financialBreakdown`. The only place that actually writes `booking.financialBreakdown` to the DB — `payments.service.ts::createPaymentForBooking` — hardcodes `agentCommissionPercent: 0` ("platform keeps full commission"). Since nothing else ever writes that field, every real payout is computed with the agent getting 0% of commission (only their markup), while the signed contract document the client/owner/agent all see shows the agent entitled to 30% of commission. This is a live money-movement bug, not a hypothetical one — the DB lookup (`grep financialBreakdown:`) confirms there's exactly one write site and it's the 0%-agent-commission path. There's also a Prisma model, `OwnerCommission`, that stores only a platform-side `commissionPercent` (default 15%, admin-settable per owner) — there is no persisted per-agent or per-booking `agentCommissionPercent` field anywhere in the schema, meaning the 30% figure in contracts and the 0% figure in payments are both just literals in code, not configurable data.

### Agent subscription / billing tiers (`src/modules/billing/`)

Two tiers only: FREE and PRO (`AgentTier` enum). Feature gates (`billing.types.ts`, `TIER_FEATURES`): FREE = 0 sub-agents, no branded checkout/analytics/priority support; PRO = unlimited sub-agents + all four features. Pricing is hardcoded: $49/mo or $399/yr (32% "savings" claim), price IDs pulled from env vars, actual Stripe Product/Price creation is a one-off CLI helper (`setupBillingProducts`), not run per-request.

- `upgradeToProTier`: ensures a Stripe customer, creates a subscription with a 30-day trial (`payment_behavior: default_incomplete`), returns a `client_secret` for Stripe Elements to collect a payment method. Local `AgentSubscription` row is upserted immediately with `status: TRIALING` — **before** Stripe confirms the payment method was actually attached, purely optimistic.
- `getPortalLink` hands off entirely to the Stripe Customer Portal (plan changes/cancellation/payment method/invoices) — no custom UI for any of that.
- `checkFeatureAccess` treats `CANCELLED`/`UNPAID` subscriptions as FREE regardless of stored `tier`.

**Confirmed dead code / broken sync**: `src/jobs/subscription-sync.job.ts` (`subscriptionSync`) is documented as "triggered by `stripe/subscription-event` (emitted from Stripe webhook handler)" and handles `customer.subscription.created/updated/deleted` to sync tier/status and fire trial-ending/past-due/cancelled notifications. But the actual webhook handler (`src/app/api/webhooks/stripe/route.ts`) has those three event types fall into a `switch` case that says `// Handled by billing module (Plan 04) -- just record the event` and then `break`s — **it never calls `inngest.send({name: "stripe/subscription-event", ...})`**. Grepping the whole repo for `"stripe/subscription-event"` shows it's only referenced inside the job file itself (as the trigger name and in comments) — nothing ever emits it. Consequence: when a Stripe subscription trial ends, converts to active, goes past-due, or gets cancelled, **the local `AgentSubscription.tier`/`status` never updates and no notification fires**. `checkFeatureAccess` would keep granting PRO access off stale local state (or vice-versa) until some other manual path touches the row. This is a materially broken piece of the billing pipeline, not a stub — the plumbing exists on both ends but the wire between them was never connected.

### Insurance (`src/modules/insurance/`)

**Entirely a stub provider.** `insurance.adapter.ts`'s `StubInsuranceProvider` is the only implementation of `InsuranceProvider`, explicitly commented "Replace with a real provider (e.g., Tint SmartSTR) when the commercial partnership is finalized." Premium formula: `guestCount * nights * 500` cents flat (no risk factors, property value, location, etc., despite `createPolicy` accepting `propertyAddress`/`propertyCountry`/`propertyValue` — those parameters are accepted but unused in the pricing math). Coverage is hardcoded: €50K property damage, €1M liability, cancellation always included.

- `insuranceActivationFlow` job (on `booking/confirmed`): calls the stub provider, stores an `InsurancePolicy` row (status ACTIVE), then generates a PDF certificate via `@react-pdf/renderer`, uploads to R2, and stores a presigned URL (24h expiry) — this part is real and functional (real PDF generation/storage, not a stub), see `insurance.service.ts` and `templates/insurance-certificate.tsx`.
- `insuranceProvider.fileClaim`, `.getClaimStatus`, and `.cancelPolicy` are **defined on the interface and implemented in the stub, but never called from anywhere else in the codebase** (verified by grep — zero call sites outside the adapter file). No policy is ever cancelled on booking cancellation, and claims never actually reach "the insurer" in any technical sense despite the UI repeatedly promising it (see Claims section).

### Claims workflow (`src/modules/claims/`)

State machine (`claims.types.ts`): `FILED → UNDER_REVIEW → {AGREED, DISPUTED} `, `AGREED → RESOLVED`, `DISPUTED → ESCALATED`, `ESCALATED → {RESOLVED, CLOSED}`, `RESOLVED → CLOSED`. Transitions use optimistic locking (`prisma.claim.update` with `status: expectedStatus` in the `WHERE`, catching Prisma's P2025 as a "claim state has changed, refresh" error).

- **Filing** (`claimsService.fileClaim`, owner-only): requires booking `COMPLETED`, no existing claim, `SecurityDeposit` in `HELD`/`CLAIM_HOLD`, filed **within 24 hours of checkout**, and `claimAmountCents >= MIN_CLAIM_AMOUNT_CENTS` (€50, `5000` cents — duplicated as a literal in both `claims.types.ts` and `deposits.types.ts`). On filing, immediately auto-transitions FILED→UNDER_REVIEW, sets `reviewDeadline = now + 72h`, flips the `SecurityDeposit` to `CLAIM_HOLD`, and emits `claim/filed`.
- **Evidence upload**: real, working — presigned-URL upload to R2 via `/api/upload/presign`, then `registerEvidenceAction` (`src/app/(owner)/owner/bookings/[id]/pre-stay-photos/actions.ts`, shared by both pre-stay and claim flows) creates a `ClaimEvidence` row typed `PRE_STAY`/`POST_STAY`/`SUPPORTING`. `fileClaimSchema` requires ≥1 evidence photo, 20+ character description. The claim form (`claim-form.tsx`) enforces image-type and 10MB-per-file limits client-side.
- **Agent review** (`agentReview`, agent-only, must own the booking): AGREED → straight to `AGREED` status; DISPUTED → `DISPUTED` then **immediately** auto-advanced to `ESCALATED` in the same call (there is no separate "disputed, awaiting escalation" window — dispute *is* escalation).
- **Auto-escalation on timeout**: `claim-review-timeout.job.ts` waits up to 72h for `claim/agent-reviewed`; if it times out, calls `autoEscalateExpiredReview` which sets `agentResponse: "NO_RESPONSE"` and pushes UNDER_REVIEW → DISPUTED → ESCALATED.
- **Resolution** (`resolveClaim`): takes an admin-supplied `deductionAmountCents` and either deducts it from the `SecurityDeposit` (`depositsService.deductFromDeposit`, which **throws if `deductionCents > deposit.amountCents`**) or releases the deposit in full if the deduction is 0. Sets `resolutionType` to only `"DEPOSIT_DEDUCTED"` or `"WITHDRAWN"`.

### Incomplete/stubs (claims + insurance)

- The UI text at every turn (`claim-form.tsx`, `claim-review-form.tsx`, `insurance-certificate.tsx`) promises claims exceeding the deposit, or disputed claims, are "escalated to the insurance provider for independent adjudication" and "the platform will not be involved." **None of this is implemented.** `resolveClaim` is the single resolution path for both AGREED and ESCALATED claims, uses the same admin-supplied number, deducts only from the security deposit (hard-capped at the deposit amount — a claim genuinely exceeding the deposit cannot be resolved by this code path without erroring), and never calls `insuranceProvider.fileClaim`/`getClaimStatus`. There is no code path anywhere that produces `resolutionType: "ESCALATED_TO_INSURER"`, even though two separate frontend pages (`agent/bookings/[id]/page.tsx`, `agent/bookings/[id]/claim/page.tsx`) contain display branches specifically for that value that can never be hit. The `Claim` model's `insuranceClaimId`/`insuranceStatus` columns are defined in the Prisma schema and never written to anywhere in the app.
- **No admin UI exists** for claim resolution at all — `resolveClaim` is only reachable via a raw REST endpoint (`POST /api/v1/claims/[id]/resolve`, `role: ADMIN`) with zero corresponding frontend page found in the codebase. An admin has to call this out-of-band (e.g. via API client) to ever close out a claim; the in-app workflow dead-ends after the agent's AGREED/DISPUTED response.
- Security-deposit charging on the standard checkout page is very likely non-functional (see "Stripe payment integration" above) — `confirmCardPayment` called with a bare client secret and no attached payment method — with no retry mechanism despite the UI claiming one.
- `subscriptionSync` Inngest job (billing tier sync from Stripe) is fully implemented but structurally unreachable — the webhook route that's supposed to trigger it never emits the event.
- The owner's deposit-installment payout share is computed (`ownerNetPayoutCents`, deposit ratio) but no job ever transfers it to the owner's Stripe account — only the balance-installment share is ever transferred.
- `totalSplitVerification` (owner+agent+platform reconciliation flag) is computed by the financial calculator and then never read anywhere else — a silent, unused sanity check.
- `onPayoutCompleted` notification job (`payment-notifications.job.ts`) reads `financials?.ownerPayoutCents`, a field that does not exist on `FinancialBreakdown` (the real field is `ownerNetPayoutCents`); it silently falls back to the raw `amountCents` passed on the event, so the bug is currently harmless but the code is dead/wrong as written.
- `calculateSimplifiedRefund` (documented as the "new" Phase-4 cancellation policy) is exported but never called outside its own unit test — `calculateRefundAmount` (the older tiered FLEXIBLE/MODERATE/STRICT policy) is what's actually wired into `processRefund`.

### Key files
- Payments core: `src/modules/payments/financial-calculator.ts`, `payments.service.ts`, `payments.queries.ts`, `payments.actions.ts`, `payments.types.ts`, `stripe-connect.adapter.ts`, `__tests__/financial-calculator.test.ts`
- Webhooks/jobs: `src/app/api/webhooks/stripe/route.ts`, `src/jobs/payout-processing.job.ts`, `balance-collection.job.ts`, `deposit-release.job.ts`, `booking-completion.job.ts`, `payment-notifications.job.ts`, `subscription-sync.job.ts`, `insurance-activation.job.ts`, `claim-review-timeout.job.ts`, `trust-safety-notifications.job.ts`
- Deposits (security/damage deposit, adjacent module not explicitly listed but load-bearing here): `src/modules/deposits/deposits.service.ts`, `deposits.types.ts`, `deposits.actions.ts`
- Billing: `src/modules/billing/billing.service.ts`, `billing.types.ts`, `billing.queries.ts`, `billing.actions.ts`, `stripe-billing.adapter.ts`
- Insurance: `src/modules/insurance/insurance.service.ts`, `insurance.adapter.ts`, `insurance.types.ts`, `templates/insurance-certificate.tsx`
- Claims: `src/modules/claims/claims.service.ts`, `claims.queries.ts`, `claims.actions.ts`, `claims.types.ts`, `claims.schema.ts`, plus `src/app/(owner)/owner/bookings/[id]/claim/claim-form.tsx` and `src/app/(agent)/agent/bookings/[id]/claim/claim-review-form.tsx`
- Shared money: `src/shared/money/currency.ts`
- Contract/commission inconsistency: `src/modules/contracts/contracts.service.ts` (lines ~34-38, 109-124) vs. `src/modules/payments/payments.service.ts` (lines ~91-116)
- Checkout UI: `src/app/checkout/[bookingId]/checkout-form.tsx`, `src/app/api/checkout/[bookingId]/create-intent/route.ts`, `create-deposit-intent/route.ts`
- Prisma models referenced: `prisma/schema.prisma` — `Payment`, `PaymentSplit`, `Payout`, `OwnerCommission`, `AgentSubscription`, `ProcessedWebhookEvent`, `SecurityDeposit`, `Claim`, `ClaimEvidence`, `InsurancePolicy`

---

## Agents, Agencies & Reputation

Scope covered: `src/modules/agents/`, `src/modules/teams/`, `src/modules/reputation/`, `src/components/team/`, plus the routes/components/schema these modules feed (`prisma/schema.prisma`, `src/app/(agent)/*`, `src/app/(admin)/admin/dashboard/agents/*`, `src/modules/selections/branding.*` for `AgentBrand`, `src/modules/billing/*` for `AgentTier`).

### 1. Agent sign-up and role grant (the gate that actually matters)

Any visitor can self-select "Booking Agent" on sign-up. Supabase stores that choice as `user_metadata.role`, and on first callback the app creates a `UserProfile` with `role: meta.role === "AGENT" ? "AGENT" : "OWNER"` — **no vetting, no application, no admin step required**.

- Files: `src/app/(auth)/sign-up/[[...sign-up]]/page.tsx`, `src/app/(auth)/callback/route.ts`
- The entire `(agent)` route group is gated only by `UserProfile.role` via `requireRole([AGENT, ADMIN])`, plus one extra check: if the caller's `AgentApplication.status === "REVOKED"`, they're bounced to `/agent/apply`. Every other status (no application at all, `PENDING`, `UNDER_REVIEW`, `REJECTED`) passes straight through with full access to search, booking creation, team management, everything.
  - File: `src/app/(agent)/layout.tsx` (lines 32–43)
- `bookingsService.createBooking` (`src/modules/bookings/bookings.service.ts`) and its server action (`src/modules/bookings/bookings.actions.ts`) never check `AgentApplication.status` either — they don't even restrict by role at all (`createAction` is called with no `role` field).

**Net effect: the "AgentApplication vetting flow" described below is cosmetic with respect to platform access.** A brand-new sign-up, a still-pending applicant, and even a formally **rejected** applicant all have identical, full access to the agent portal (search properties, create real bookings, invite sub-agents, brand a client-facing selection page). The only status that blocks anything is `REVOKED`, and — see §5 — even that can only be applied to applicants who were previously `APPROVED`, since the admin "Revoke" button (`canRevoke = application.status === "APPROVED"`) never renders for a `PENDING`/`REJECTED` applicant. So an admin who rejects an application has **no UI action available** to actually lock that user out; they keep full agent access indefinitely.

### 2. Agent application (vetting) form and data model

`AgentApplication` (1:1 with `UserProfile` via unique `userId`) collects:
- Business credentials: `companyName` (min 2 chars), `registrationNumber` (optional), `companyAddress` (min 10 chars), `companyWebsite` (optional URL)
- Insurance & licensing: `insuranceDocR2Key`, `licenseDocR2Key` (R2 object keys from a presigned-upload flow), `insuranceExpiry` (date)
- Track record: `yearsInBusiness` (int, min 1), `annualBookingVolume` (enum `1-10`/`11-50`/`51-100`/`100+`), `propertyTypes` (array, min 1, from `luxury_villa`/`estate`/`chalet`/`apartment`/`penthouse`/`other`)
- References: 2–3 entries, each requiring `name`, `company`, valid `email`, `relationship` (phone optional)

Files: `src/modules/agents/agents.schema.ts`, `src/modules/agents/agents.types.ts`, `src/components/forms/agent-application-form.tsx` (5-step wizard), Prisma model at `prisma/schema.prisma:310-356`.

- `agentsService.submitApplication` throws if a `AgentApplication` already exists for the user **regardless of its status** — there is no reapplication path after a rejection. The only way forward for a rejected applicant is manual support contact (per the UI copy on `/agent/apply/status`); no admin action exists to reset/delete an application and let someone reapply.
- The multi-step form's `validateStep` map has an **empty validation array for step 1 (Insurance & Licensing)**, and the Zod schema itself marks `insuranceDocR2Key`/`licenseDocR2Key` as `.optional()`. This directly contradicts the step's own copy ("These are required for approval") — an applicant can click through the entire wizard and submit with zero documents attached.

### 3. Admin review (approve / reject / revoke)

`AgentApplication.status` state machine: `PENDING → UNDER_REVIEW → APPROVED | REJECTED`, and `APPROVED → REVOKED`.

- Admin queue: `/admin/dashboard` lists all applications (`agentsService.getAllApplications`), detail page at `/admin/dashboard/agents/[id]` (`src/app/(admin)/admin/dashboard/agents/[id]/page.tsx`).
- **Approve**: sets status `APPROVED`, records `reviewedByAdminId`/`reviewedAt`/optional `reviewNote`. No role change happens here — role was already `AGENT` at signup (see §1).
- **Reject**: requires a non-empty `rejectionReason` (enforced both by `reviewApplicationSchema`'s `.refine()` and a redundant explicit check in the action). Sets status `REJECTED`.
- **Revoke**: only offered when `status === "APPROVED"` (`canRevoke` in `agent-detail-actions.tsx`). Sets status `REVOKED`, which is the one status the agent layout guard actually checks (redirects to `/agent/apply`).
- Admin-only enforcement is correct here: `approveApplication`/`rejectApplication`/`revokeAgentAccess` all call `requireAdminAuth()` (checks `isAdmin`).
- Insurance/license documents are shown to the admin only as a green "Uploaded" checkmark — **there is no view/download link anywhere in the codebase for `insuranceDocR2Key`/`licenseDocR2Key`** (confirmed via full-repo grep). The admin can confirm *something* was uploaded but can never actually inspect the document, undermining the stated purpose of collecting it.
- `UNDER_REVIEW` exists in the enum, is displayed in UI badges/filters, and is grouped with `PENDING` in every query — but **no code path in the entire repo ever sets an application to `UNDER_REVIEW`**. It's a dead state; only `PENDING`, `APPROVED`, `REJECTED`, `REVOKED` are ever actually reached.

Files: `src/modules/agents/agents.service.ts`, `agents.queries.ts`, `agents.actions.ts`, `src/app/(admin)/admin/dashboard/agents/[id]/agent-detail-actions.tsx`.

### 4. Agent tiers (FREE / PRO)

Lives in `src/modules/billing/` (not `src/modules/agents/`), backing the `AgentSubscription`/`AgentTier` Prisma models (`prisma/schema.prisma:835-874`).

- `TIER_FEATURES`: FREE = `maxSubAgents: 0`, no branded checkout, no analytics, no priority support. PRO = unlimited sub-agents (`-1`), branded checkout, analytics, priority support. Pricing: $49/mo or $399/yr, 30-day trial (`src/modules/billing/billing.types.ts`).
- `billingService.checkFeatureAccess(agentId, feature)` implements the actual gate logic, and is exposed as a server action (`checkFeatureAccess` in `billing.actions.ts`).
- **This gate is never called from anywhere that matters.** `teamsService.inviteSubAgent` (§6) does not call it — a FREE-tier agent can invite unlimited sub-agents with zero paywall. The branded-selection page renderer (`selectionsQueries.getAgentBrandBySlug`, `selections.service.ts`) applies any agent's `AgentBrand` colors/logo/tagline unconditionally — FREE-tier agents get "branded checkout" for free too. The `checkFeatureAccess` server action itself is never imported by any `.tsx` component (grepped repo-wide) — it's dead code. So the FREE/PRO distinction is fully implemented for Stripe billing/subscription lifecycle (`billingService.upgradeToProTier`, `syncSubscriptionStatus`, webhook handling) but **completely unenforced** at the two feature boundaries it's documented to gate.

### 5. AgentBrand (white-label branding)

Yes, this exists, but lives under `src/modules/selections/branding.*`, not `src/modules/agents/`. One `AgentBrand` row per agent (`prisma/schema.prisma:1287-1319`).

- Agent-editable via `/agent/settings/branding` (`src/app/(agent)/agent/settings/branding/page.tsx`, `src/components/selections/brand-settings-form.tsx`): `primaryColor`/`secondaryColor`/`accentColor` (hex-validated), `fontFamily`, `tagline` (≤200 chars), `footerText` (≤500 chars), logo upload (≤5MB, images only), cover image upload (≤10MB, images only). Uploads go straight to R2 via `PutObjectCommand` and are made public via `R2_PUBLIC_URL`.
- Applied to public client-facing `Selection` pages (curated villa lists an agent shares with a client) via `getAgentBrandBySlug` — the brand's colors/logo/tagline/footer are pulled in when rendering the public selection page.
- Files: `src/modules/selections/branding.service.ts`, `branding.schema.ts`, `branding.actions.ts`, `branding.types.ts`, `src/modules/selections/selections.queries.ts` (`getAgentBrandBySlug`), `selections.service.ts` (`getCachedPublicSelection`).
- `updateBrandSettingsAction`/`uploadLogoAction`/`uploadCoverImageAction` only call `getAuthContext()` — no role check restricting this to `AGENT` (relies entirely on the route being under `/agent/*`).

**Custom domain — stub only.** `AgentBrand.customDomain`/`customDomainVerified` fields exist in the schema with a comment "Custom domain (Pro tier only)", but a repo-wide grep shows they are referenced **only** as `null`/`false` defaults in `branding.service.ts`. There is no UI to set a custom domain, no DNS/verification logic, and no tier gate — this is schema-only.

### 6. Agency / Team (main agent + sub-agents)

Models: `Agency` (1 owner, `ownerId` unique — one agency per owner), `AgencyMember` (join table, `role: ADMIN | MEMBER`, default `MEMBER`), `AgencyInvite` (`PENDING | ACCEPTED | EXPIRED | REVOKED`). `prisma/schema.prisma:1321-1379`.

**Invite flow** (`teamsService.inviteSubAgent`, `src/modules/teams/teams.service.ts`):
1. Lazily creates an `Agency` for the caller on their **first** invite if they don't already own one (name defaults to their `AgentApplication.companyName`, or `"{firstName}'s Agency"`).
2. Upserts an `AgencyInvite` keyed on `[agencyId, email]`; blocks a second invite while one is `PENDING`.
3. Emits `team/invite-sent` via Inngest for notification dispatch.
4. Invite acceptance at `/agent/team/invite/accept?invite={id}` (`src/app/(agent)/agent/team/invite/accept/page.tsx`) verifies the invite is `PENDING`, the signed-in user's email matches, then **directly runs its own `prisma.$transaction`** to create the `AgencyMember` (hardcoded `role` omitted → defaults `MEMBER`) and mark the invite `ACCEPTED` — this duplicates, rather than calls, `teamsService.acceptInvite`. Consequence: it skips the "already a member" guard that the service method has, and it never emits the `team/invite-accepted` Inngest event, so notifications don't fire for invites accepted through this page (the separate `acceptTeamInvite` server action, which does call the service method correctly, appears unused by any UI — the page bypasses it).
5. `AgencyInvite.expiresAt` is declared in the schema and `AgencyInviteStatus.EXPIRED` exists, but **nothing in the codebase ever sets `expiresAt` or transitions an invite to `EXPIRED`** — invites never expire in practice.

**Roles**: `AgencyMemberRole.ADMIN` is defined in the schema but **never assigned or checked anywhere** — every member is created with `role: "MEMBER"` and no code path reads `AgencyMember.role` for a permission decision. It's a fully unused enum value; there is only one real tier of team member (main agent = `Agency.ownerId`, everyone else = plain member with no elevated permissions).

**Commission split**: set at booking-creation time via `subAgentSplitPercent` on the `Booking` itself (0–100, optional), not via a separate "assign split" step. Computed downstream with `Decimal.js`: `subAgentShareCents = floor(agentCommissionCents * splitPercent / 100)`; `mainAgentShareCents = agentCommissionCents - subAgentShareCents`. Files: `src/modules/teams/teams.queries.ts` (`getTeamCommissionSummary`, `getSubAgentCommission`), `teams.service.ts` (`getTeamBookings`).
- **Notable gap**: the "Sub-Agent Commission Split (%)" field on the booking form is shown to *any* agent with `hasAgency = true`, which is computed as "owns an agency **OR** is a member of one" (`src/app/(agent)/agent/bookings/new/page.tsx:66-79`). So a sub-agent booking on their own behalf can set their own `subAgentSplitPercent` value (e.g. 100%) with no server-side check that only the main agent may set/approve it, and no stored "agreed split" to validate against — `bookingsService.createBooking` accepts `data.subAgentSplitPercent` verbatim from client input.
- `teams.schema.ts` also defines a `setCommissionSplitSchema` for changing a booking's split after the fact — it is never imported by any action, service, or component. Dead code.

**Deactivation & reassignment** (`SubAgentList` → `ReassignBookingsDialog` → `deactivateSubAgent`):
- Verifies the sub-agent is a real `AgencyMember` of the caller's agency before acting.
- Optionally reassigns their active bookings (`REQUESTED`/`APPROVED`/`PAID`/`CONFIRMED`) to another member or to `"self"` (the main agent), then deletes the `AgencyMember` row.
- **The confirmation dialog's copy is materially wrong**: it states "They will lose access to bookings and the agent portal." In reality, deleting the `AgencyMember` row only removes them from the team roster/commission rollups — it does **not** touch `UserProfile.role` or `AgentApplication.status`, and portal access (per §1) is governed entirely by those two fields. A "deactivated" sub-agent keeps full, unrestricted agent-portal access and can keep creating new bookings as a standalone agent immediately after being "deactivated."
- The standalone `reassignBookings` server action (`teams.actions.ts`) is **not called by any UI component** (only `deactivateSubAgent`'s internal, membership-checked call path is used in practice). If invoked directly, it has a real gap: `teamsService.reassignBookings` only verifies the *caller* owns some agency — it never verifies that `fromAgentProfileId` (or `toAgentProfileId`) is actually a member of that agency. `teamsQueries.reassignBookings` does an unscoped `updateMany({ where: { agentId: fromAgentProfileId, status: {in: ACTIVE} } })`, so a malicious/curious main agent who knows another platform agent's profile UUID could reassign that unrelated agent's active bookings into their own team. `deactivateSubAgent`'s own call path avoids this because it checks membership first, but the action exposing `reassignBookings` directly does not carry the same guard.

**Team page routing bug**: `SubAgentList`'s "View Bookings" dropdown action navigates to `window.location.assign(\`/team?subAgentId=${member.userId}\`)` — the real route is `/agent/team` (there is no `/team` route at all), and even if fixed, `/agent/team`'s page and `TeamBookingsTable` never read a `subAgentId` query param, so the filter-by-sub-agent feature this button implies doesn't exist end-to-end.

**Sub-agent-view mislabeling**: `/agent/team`'s server component treats "does not own an Agency" as equivalent to "is a sub-agent on someone else's team" and shows "You are part of a team. Contact your team lead..." — it never checks whether the caller is actually an `AgencyMember` of anything. A brand-new solo agent with zero team affiliation sees this same misleading message.

Files: `src/modules/teams/teams.service.ts`, `teams.queries.ts`, `teams.actions.ts`, `teams.schema.ts`, `src/components/team/invite-sub-agent.tsx`, `sub-agent-list.tsx`, `reassign-bookings-dialog.tsx`, `team-bookings-table.tsx`, `team-stats.tsx`, `src/app/(agent)/agent/team/page.tsx`, `src/app/(agent)/agent/team/invite/accept/page.tsx`.

**Multi-agency nesting** (design note, not clearly a bug): because `inviteSubAgent` only checks `Agency.ownerId` for the caller, a user who is already a sub-agent (`AgencyMember`) elsewhere can freely spin up and own their own separate `Agency` by sending their first invite — the team page's copy for non-owners explicitly points them at the invite form for this ("Use the invite form below to set up your own team"). Nesting/hierarchy of agencies is unbounded and untracked (no parent-agency relationship).

### 7. Reputation / ratings

`Rating` model, one row per `[bookingId, raterId]` (unique), thumbs up/down only.

- **Who rates whom**: strictly the two parties on a specific booking — the property owner rates the agent, the agent rates the owner. `reputationService.rateUser` enforces: booking must be `COMPLETED`; caller must actually be the booking's owner (if `raterRole=OWNER`) or agent (if `raterRole=AGENT`); `rateeId` must be the other party; one rating per booking per rater (upsert semantics allow editing your own rating, not adding a second).
- **Mediation quality bonus**: when an `OWNER` rates an `AGENT` and the booking had an associated `Claim`, two extra booleans can be captured — `respondedOnTime` (agent responded to the claim within the review window) and `resolvedWithoutEscalation` (resolved without going to the insurer). Any rating carrying either of these fields is weighted **1.5×** (`MEDIATION_WEIGHT`) in the aggregate percentage calculation vs. 1× for a plain rating.
- **Aggregate display**: `MIN_REVIEWS_FOR_DISPLAY = 5` — under 5 total ratings, a user shows a gray "New Agent"/"New Owner" badge instead of a percentage. At 5+, `RatingBadge` colors green (≥80%), amber (≥60%), or red (<60%).
- **What it actually affects**: nothing systemic. `RatingBadge`/`getUserRatingAction` are only rendered on the counterpart's own booking-detail page (`/owner/bookings/[id]` shows the agent's badge, `/agent/bookings/[id]` shows the owner's badge) — a repo-wide grep confirms ratings are never read by search/ranking, the admin agent list, or anything tier/vetting-related. It's purely an informational display between the two parties on a shared booking.
- **UI-level rating gate** (not enforced server-side): both booking detail pages only show the "Rate" button once `booking.status === "COMPLETED"` **and** the security deposit has been released — the server action itself only requires `COMPLETED`, so this deposit-released gate is a client-side UX choice, not a backend rule.

Files: `src/modules/reputation/reputation.service.ts`, `reputation.queries.ts`, `reputation.actions.ts`, `reputation.types.ts`, `src/components/reputation/rating-badge.tsx`, `rating-dialog.tsx`.

### 8. Guest flags (reputation, but for guests, not agents)

`GuestFlag` model — owners or agents can flag a guest (by email) after a completed stay with a category: `party`, `damage`, `rule_violation`, `noise`, `excessive_cleaning`, `family`, `business`, `corporate`, `other`, plus free-text `notes`.

- Same permission pattern as ratings: booking must be `COMPLETED`, caller must be the owner or agent on that specific booking, one flag per booking per flagger (`hasExistingFlag`).
- `guestEmail` is taken from `booking.guestEmail` (falls back to the submitted param) and lower-cased for matching across bookings.
- Lookup (`getGuestReputationAction`) is **case-insensitive** and aggregates all historical flags for that email across all properties/agents, shown on both the owner's and the agent's booking-detail pages (`flag-guest-dialog.tsx`, `trust-safety-section.tsx`, `agent/bookings/[id]/page.tsx`).
- **Gap**: guest flags are only surfaced retrospectively, on a booking that's already `COMPLETED` — the flag lookup is never invoked at booking-creation time (`booking-form.tsx` collects `guestEmail` but never queries guest reputation), so an agent gets no warning about a previously-flagged guest at the point where it would actually be actionable (before committing to the booking).

Files: `src/modules/reputation/reputation.service.ts`, `reputation.queries.ts`, `src/app/(owner)/owner/bookings/[id]/flag-guest-dialog.tsx`, `trust-safety-section.tsx`.

### Incomplete / stubs

- **Vetting doesn't gate access (critical)**: `UserProfile.role = AGENT` is granted at sign-up with zero review; the agent portal layout only blocks `REVOKED` applicants, not `PENDING`/`REJECTED`/no-application. The entire `AgentApplication` approve/reject workflow is disconnected from actual platform access. — `src/app/(agent)/layout.tsx`, `src/app/(auth)/callback/route.ts`
- **No way to lock out a rejected applicant**: admin's "Revoke" button only appears for `APPROVED` applications, so a `REJECTED` applicant (who already has full access per above) can never be cut off through the UI. — `src/app/(admin)/admin/dashboard/agents/[id]/page.tsx`
- **"Deactivate sub-agent" doesn't revoke portal access**, despite the confirmation dialog's copy claiming it does — it only removes the `AgencyMember` row. — `src/components/team/reassign-bookings-dialog.tsx`
- **Insurance/license docs are effectively optional** despite UI copy calling them required (schema marks them `.optional()`, wizard step has no validation gate), and admins have no way to actually view an uploaded document, only a "was something uploaded" checkmark.
- **`UNDER_REVIEW` application status is unreachable** — modeled, displayed, and queried everywhere, but no code path ever sets it.
- **No reapplication flow** after `REJECTED` — `submitApplication` blocks resubmission for any existing application regardless of status.
- **`AgencyMemberRole.ADMIN` is unused** — schema-only, every member is hardcoded `MEMBER`, no permission check ever reads this field.
- **`AgencyInvite.expiresAt` / `EXPIRED` status unused** — never set, never checked; invites are effectively permanent until accepted or manually revoked.
- **`setCommissionSplitSchema` is dead code** — split is set inline at booking creation by whoever creates the booking (main agent or the sub-agent themselves), with no dedicated endpoint, no authorization check restricting who can set it, and no persisted "agreed split" to validate against.
- **`reassignBookings` server action lacks ownership verification** on `fromAgentId`/`toAgentId` relative to the caller's agency (the only UI path that uses reassignment, via `deactivateSubAgent`, does check membership correctly; the standalone exported action does not).
- **"View Bookings" per-sub-agent link is broken**: wrong route (`/team` vs. actual `/agent/team`) and the target page/table never reads the intended `subAgentId` filter anyway.
- **Team page mislabels solo agents** as "part of a team" whenever they don't own an agency, without checking actual `AgencyMember` status.
- **Agent tier feature gates are declared but unenforced**: `maxSubAgents` (FREE=0/PRO=unlimited) is never checked by the invite flow; `brandedCheckout` is never checked by the public selection-page renderer; the `checkFeatureAccess` server action exists but is never called from any component. — `src/modules/billing/billing.types.ts`, `billing.service.ts`
- **`AgentBrand.customDomain`/`customDomainVerified`** — schema fields only, no UI, no DNS verification, no tier gate despite the "Pro tier only" schema comment.
- **Revoking a main (agency-owning) agent has no cascading effect** on their sub-agents — the sub-agents' own access and the Agency itself continue functioning unaffected.
- **Guest-flag reputation is retrospective-only** — never queried at booking-creation time, so it can't actually prevent/warn against booking a known-problem guest.

---

## Messaging, Notifications & Push

### Real-time messaging transport (SSE)

The app has no WebSocket layer — all "real-time" behavior is Server-Sent Events over long-lived HTTP connections, backed by **database polling**, not pub/sub.

- **Shared stream factory** (`src/shared/sse/stream.ts`, `createSSEStream`): wraps a `ReadableStream` that runs a caller-supplied `onInit` once, then an `onPoll` callback on a `setInterval` (default 3s, overridden per-endpoint), plus a `: heartbeat\n\n` comment every 15s to keep the connection alive through proxies. Cleans up both intervals and closes the controller on client abort (`req.signal`) or on any enqueue error. Event IDs are passed through as SSE `id:` lines to support `Last-Event-ID` resumption.
- **Client hook** (`src/shared/sse/use-event-source.ts`, `useEventSource`): thin wrapper around the browser `EventSource` API. Parses each `message` event as JSON (silently swallows parse failures, which is how heartbeats are ignored). On `onerror` it closes the socket and auto-reconnects after 3s (configurable), forever, as long as `enabled` stays true — no backoff, no max-retry cap.
- **Message stream** (`src/app/api/messages/stream/[threadId]/route.ts`): authenticates via Supabase cookie session or a `Bearer` header fallback for mobile, then re-verifies the caller is the booking's agent or the property owner before opening the stream (403 otherwise). Supports resumption via `Last-Event-ID` (falls back to sequence `0`). Polls every 5s for `messagingQueries.getMessagesSince(threadId, lastSequenceNum)` and streams any new rows as `{type:"message", message}`.
- **Notification stream** (`src/app/api/notifications/stream/route.ts`): same auth pattern, no per-resource authorization needed (notifications are already scoped to `userId`). Sends an initial `unread_count` on connect, then polls every 10s for notifications created since the last poll timestamp; only re-queries the unread count when new notifications actually showed up (an explicit DB-load optimization).
- Both endpoints are `export const runtime = "nodejs"; export const dynamic = "force-dynamic"` — no edge runtime, no caching.

**Practical implication**: messages/notifications never arrive faster than the poll interval (5s / 10s) and every open tab holds an idle DB polling loop; this scales by connection count × poll rate, not by event volume — fine at current traffic, would need pub/sub (Postgres LISTEN/NOTIFY, Redis, etc.) to scale further.

### Messaging domain (`src/modules/messaging/`)

**Data model** (Prisma): `MessageThread` (1:1 with a `Booking` via unique `bookingId`, `createdById`, `archivedBy: String[]` for per-user archive), `Message` (`threadId`, `senderId`, `content` text, `sequenceNum` monotonic per-thread, `isRead`/`readAt`), `MessageAttachment` (`r2Key`, `url`, `fileName`, `fileType`, `fileSizeBytes`).

- **Thread creation** — agent-initiated only. `messagingService.createThread` (`messaging.service.ts`) verifies the caller is the `booking.agentId`, rejects if a thread already exists for that booking (1:1 via unique `bookingId`), creates the thread, and fires an `message/thread-created` Inngest event. **That event has no subscriber anywhere in `src/app/api/inngest/route.ts`** — creating a thread notifies nobody.
- **Sending a message** — `sendMessage` verifies the sender is either the booking's agent or the property owner, inserts the message inside a `$transaction` that atomically computes `sequenceNum = max(sequenceNum)+1` per thread and bumps `thread.updatedAt` (for inbox sort order), then emits `message/sent` with a 100-char preview. That event is consumed by `src/jobs/message-notifications.job.ts` (`onMessageSent`), which creates a `NEW_MESSAGE` in-app notification **and** sends an email, both addressed to "the other party" (looked up by role to build the correct `/agent/messages` vs `/owner/messages` deep link).
- **Attachments**: `registerAttachment` is a two-step upload — the client gets a presigned R2 URL from `/api/upload/presign`, PUTs the file directly to R2, then calls this action to record metadata. Server-side validation: file type must be in `ALL_ALLOWED_FILE_TYPES` (JPEG/PNG/WebP/GIF images; PDF/DOC/DOCX/XLS/XLSX documents), size ≤ 10MB (`MAX_FILE_SIZE_BYTES`), and ≤ 5 attachments per message (`MAX_ATTACHMENTS_PER_MESSAGE`, counted via `messagingQueries.countAttachments`). The `messaging.actions.ts` `registerAttachment` action additionally checks the caller is agent/owner/thread-creator/admin before allowing registration — this check is duplicated ad hoc in the action rather than delegated to the service.
- **Read receipts**: `markAsRead`/`markThreadAsRead` marks all messages **not sent by the caller** as read (`isRead=true`, `readAt=now()`) — i.e. reading your own thread marks the other party's messages as read for you, standard 1:1 semantics. `getThread` also fires this as fire-and-forget on every open (errors are swallowed).
- **Inbox / grouping**: `getInbox` groups threads into `active` (`APPROVED`/`PAID`/`CONFIRMED` booking status), `pending` (`REQUESTED`), `past` (`COMPLETED`/`CANCELLED`/`EXPIRED`, or no booking status at all). Unread count per thread is computed server-side via a Prisma `_count` on messages `{senderId: {not: userId}, isRead: false}`. Threads the caller has archived (`archivedBy` array contains their userId) are excluded entirely from `getInboxThreads`.
- **Search**: `messagingService.searchMessages` / `messagingQueries.searchMessages` does a real case-insensitive DB search over `content` and attachment `fileName`, optionally scoped to one thread, else scoped to all threads the user has access to (top 50 by recency). **This is fully implemented but never called from any UI component** — the search box in `Inbox` (`src/components/messaging/inbox.tsx`) only does client-side `.filter()` over the already-loaded thread previews (property name / other-party name / last-message text), not a real search of message history. The `searchMessages` server action and query are dead code from the UI's perspective.
- **Archiving**: `archiveThread` action pushes the caller's `userProfileId` onto `archivedBy` — **but does not verify the caller has access to the thread first** (no agent/owner check, unlike every other messaging action). Any authenticated user can archive-for-themselves an arbitrary thread ID; low real-world impact since it only affects a filter that's already scoped to their own bookings, but it's an inconsistency with the rest of the module's access checks.
- **REST mirror for mobile** (`src/app/api/v1/messaging/*`): `GET/POST /api/v1/messaging` (inbox / create thread), `GET /api/v1/messaging/[threadId]` (get thread), `POST /api/v1/messaging/[threadId]/messages` (send), `POST /api/v1/messaging/[threadId]/read` (mark read) — all backed by the same `messagingService`. No v1 endpoint for attachment registration, thread archiving, or message search.

### Messaging UI (`src/components/messaging/`)

- `Inbox` — sidebar (grouped, collapsible `ThreadGroup`s: Active/Pending/Past, unread badges) + main conversation pane. Desktop shows both panes; mobile hides the list once a thread is opened (`mobileShowThread` state) with a back button. On mobile, thread rows are wrapped in `SwipeableThreadItem` (swipe-to-archive / swipe-to-mark-read via `react-swipeable-list`). Takes a `showStartConversation` prop that is **destructured but never read anywhere in the component** — dead/no-op prop.
- `ConversationThread` — renders messages, subscribes to the per-thread SSE stream, deduplicates incoming SSE messages against `lastSequenceNumRef` (ignores anything `<=` last known sequence), shows a live/reconnecting indicator (Wifi icon) driven by `isConnected` from `useEventSource`. Computes a "Read" receipt shown under the sender's own last message only when every subsequent message from the other party is marked read AND at least one reply from them exists after it (a real, if slightly convoluted, correctness check). Calls `markThreadAsRead` on mount for every thread open.
- `MessageComposer` — auto-resizing textarea, Enter-to-send / Shift+Enter-for-newline, client-side attachment validation mirroring the server's allowed types/size/count before upload, per-file upload progress state, and if a message has no text but has attachments the client fills placeholder content `"(attachment)"` since the schema requires ≥1 char. Sends the text message first, then uploads/registers each attachment sequentially (not parallel) with independent error handling per file (a failed attachment doesn't block others or roll back the message).
- `MessageBubble` / `ReadReceipt` — simple left/right bubble layout, sender-name shown only on the first message of a consecutive run.
- `AttachmentPreview`/`AttachmentList` — images render as inline thumbnails (click-through to full URL), documents render as an icon + filename + human file size + download link. Icon selection keys off MIME type (image/pdf/spreadsheet/word/generic).

### Notifications domain (`src/modules/notifications/`)

`NotificationType` is a 39-value Prisma enum. `DEFAULT_PREFERENCES` (in `notifications.types.ts`) defines default email/in-app/push toggles per type, and `getPreferenceForEvent` (in `notifications.service.ts`) looks up a stored `NotificationPreference` row (unique on `userId`+`eventType`) and falls back to that default if the user never customized it.

- `notificationsService.create` — respects `inAppEnabled`; returns `null` (no row written) if disabled.
- `notificationsService.sendEmail` — respects `emailEnabled`; looks up the user's email from `UserProfile`, calls `sendNotificationEmail` (Resend), logs-and-swallows failures (never throws, so email failure can't block anything else).
- `notificationsService.notify` — the combined helper: creates the in-app row, optionally sends email (only if an `EmailTemplate` is passed by the caller), and — independently — sends a **web/Expo push** if `pushEnabled` is true and the in-app notification was actually created (i.e., push is skipped if `inAppEnabled` is off, even if `pushEnabled` is on — the two are not fully independent despite the UI implying three independent toggles). Push payload's `badge` is populated from a fresh `getUnreadCount` call.

**What triggers each `NotificationType`** (traced through every caller in `src/jobs/*.job.ts`, `src/app/api/webhooks/docusign/route.ts`, and `src/modules/payments/payments.service.ts`, all wired via Inngest and registered in `src/app/api/inngest/route.ts`):

| Type | Trigger (event / cron) | Source |
|---|---|---|
| `BOOKING_REQUESTED` | `booking/requested` → notifies owner | `booking-notifications.job.ts` |
| `BOOKING_APPROVED` | `booking/approved` → notifies agent | `booking-notifications.job.ts` |
| `BOOKING_PAID` | `booking/paid` → notifies owner (in-app only, no email) | `booking-notifications.job.ts` |
| `BOOKING_CONFIRMED` | `booking/confirmed` → notifies agent + owner | `booking-notifications.job.ts` |
| `BOOKING_CANCELLED` | `booking/cancelled` → notifies whichever party didn't cancel | `booking-notifications.job.ts` |
| `BOOKING_EXPIRED` | `booking/expired` (fired by `booking-hold-timeout.job.ts` when the approval hold times out unpaid) → notifies agent + owner | `booking-notifications.job.ts` |
| `BOOKING_HOLD_WARNING` | **Enum + default preference + email template (`booking-hold-warning.tsx`) exist, but no code anywhere ever creates this notification.** Dead type. | — |
| `NEW_MESSAGE` | `message/sent` (from `messagingService.sendMessage`) → notifies the other party, in-app + email | `message-notifications.job.ts` |
| `SUB_AGENT_BOOKING` | **Never triggered anywhere** — enum/default/label only. | — |
| `SUB_AGENT_JOINED` | **Never triggered anywhere** — enum/default/label only (no email template either). | — |
| `CONTRACT_READY` | `contract/sent` → notifies agent (on behalf of client) + owner | `payment-notifications.job.ts` |
| `CONTRACT_SIGNED_PARTY` | `contract/signer-completed` → notifies the parties who haven't signed yet | `payment-notifications.job.ts` |
| `CONTRACT_ALL_SIGNED` | `contract/all-signed` → notifies agent + owner | `payment-notifications.job.ts` |
| `CONTRACT_DECLINED` | DocuSign webhook decline event → notifies agent + owner | `src/app/api/webhooks/docusign/route.ts` |
| `CONTRACT_REMINDER` | `booking/approved` → `contract-reminders.job.ts` waits 24h, then 48h, then daily up to `MAX_DAILY_REMINDERS`, stopping early if `contract/all-signed` fires | `contract-reminders.job.ts` |
| `PAYMENT_LINK_SENT` | Whenever a checkout link is (re)generated for a booking → notifies agent | `payments.service.ts` (`sendPaymentLink`) |
| `PAYMENT_RECEIVED` | `booking/paid` → notifies agent + owner, in-app + email (**note: distinct from and in addition to `BOOKING_PAID` above — same underlying event fires two separate notification rows to the owner**) | `payment-notifications.job.ts` |
| `PAYMENT_FAILED` | `payment/failed` → notifies agent | `payment-notifications.job.ts` |
| `BALANCE_DUE_REMINDER` | `payment/balance-due` (fired by the daily `balance-collection-scheduler` cron when a balance's due date passes) → day-1 reminder to agent | `balance-collection.job.ts` |
| `BALANCE_OVERDUE` | Same flow, day-3 and day-5 escalating reminders to agent | `balance-collection.job.ts` |
| `BALANCE_AUTO_CANCELLED` | Same flow, day-6 auto-cancel → notifies agent + owner | `balance-collection.job.ts` |
| `PAYOUT_COMPLETED` | `payout/completed` → notifies owner | `payment-notifications.job.ts` |
| `SUBSCRIPTION_TRIAL_ENDING` | `stripe/subscription-event` sync job, trial-ending branch → notifies agent | `subscription-sync.job.ts` |
| `SUBSCRIPTION_ACTIVATED` | Same job, activation and "payment issue" branches (reuses the same type for both a welcome message and a payment-issue message) → notifies agent | `subscription-sync.job.ts` |
| `SUBSCRIPTION_CANCELLED` | Same job, cancellation branch → notifies agent | `subscription-sync.job.ts` |
| `CLAIM_FILED` | `claim/filed` → notifies agent | `trust-safety-notifications.job.ts` |
| `CLAIM_AGREED` | `claim/agent-reviewed` (agreed branch) → notifies owner | `trust-safety-notifications.job.ts` |
| `CLAIM_DISPUTED` | `claim/agent-reviewed` (disputed branch) → notifies owner | `trust-safety-notifications.job.ts` |
| `CLAIM_RESOLVED` | `claim/resolved` → notifies owner + agent | `trust-safety-notifications.job.ts` |
| `CLAIM_ESCALATED` | `claim/escalated` → notifies owner + agent | `trust-safety-notifications.job.ts` |
| `DEPOSIT_RELEASED` | `deposit/released` → notifies agent + owner | `trust-safety-notifications.job.ts` |
| `DEPOSIT_CHARGED` | `deposit/charged` → notifies agent | `trust-safety-notifications.job.ts` |
| `RATING_REQUESTED` | `reputation/prompt-rating` (fired after deposit release) → prompts owner to rate agent and agent to rate owner | `rating-prompt.job.ts` |
| `PRE_STAY_PHOTOS_REMINDER` | `booking/confirmed` → reminds owner to upload pre-stay photos (two escalating reminders); in-app **disabled by default** (`inAppEnabled: false`), so this is email-only by default | `pre-stay-photo-reminder.job.ts` |
| `SELECTION_VILLA_CONFIRM` | `selection/villa-added-pending` + a daily reminder cron → notifies owner (in-app + email) | `selection-availability.job.ts` |
| `SELECTION_VILLA_CONFIRMED` | `selection/villa-confirmed` → notifies agent | `selection-notifications.job.ts` |
| `SELECTION_VILLA_UNAVAILABLE` | Owner non-response timeout or explicit unavailability in the confirmation flow → notifies agent | `selection-availability.job.ts` |
| `SELECTION_VIEWED` | `selection/viewed` → notifies agent | `selection-notifications.job.ts` |
| `SELECTION_VILLA_FAVORITED` | `selection/villa-favorited` (favorite only, not unfavorite) → notifies agent | `selection-notifications.job.ts` |
| `SELECTION_BOOKING_REQUESTED` | `selection/booking-requested` → notifies agent, in-app + email | `selection-notifications.job.ts` |
| `SELECTION_UPDATED` | **Never triggered anywhere** — enum/default/label only (email default is on, in-app default is off, but nothing ever calls it). There's also an unused `SelectionUpdatedEmail` React component (`src/emails/selection-updated.tsx`) that's never imported by `notifications.email.ts`. | — |

Email delivery (`notifications.email.ts`, via Resend, `sendNotificationEmail`) only has templates for a subset of types — `BOOKING_REQUESTED/APPROVED/EXPIRED/CANCELLED/CONFIRMED`, `NEW_MESSAGE`, `SUB_AGENT_INVITE` (not a `NotificationType`, used for the separate agency-invite flow), `CONTRACT_READY/ALL_SIGNED`, `PAYMENT_LINK_SENT/RECEIVED`, `BALANCE_DUE_REMINDER`, `PAYOUT_COMPLETED`, `BOOKING_HOLD_WARNING` (template exists, unused as noted above), and the selection-link/booking-requested/confirm templates. Types like `BOOKING_PAID`, `CONTRACT_SIGNED_PARTY/DECLINED/REMINDER`, `PAYMENT_FAILED`, `BALANCE_OVERDUE/AUTO_CANCELLED`, all `SUBSCRIPTION_*`, all `CLAIM_*`, `DEPOSIT_*`, `RATING_REQUESTED`, `PRE_STAY_PHOTOS_REMINDER`, and most `SELECTION_*` types have **no `EmailTemplate` case at all** — their callers only ever invoke `notificationsService.create` (in-app only), so even though `DEFAULT_PREFERENCES` marks most of these `emailEnabled: true`, no email can actually be sent for them; the preference is honored but there's nothing to send.

### Notification preferences UI (`src/components/notifications/notification-preferences.tsx`)

- Renders a 3-column (Email / In-App / Push) toggle grid, one row per event type, backed by `getNotificationPreferences`/`updateNotificationPreference` server actions with optimistic UI updates that revert on failure.
- **Only 10 of the 39 `NotificationType` values are actually configurable**: the hardcoded `EVENT_TYPE_ORDER` array covers `BOOKING_REQUESTED/APPROVED/PAID/CONFIRMED/CANCELLED/EXPIRED/HOLD_WARNING`, `NEW_MESSAGE`, `SUB_AGENT_BOOKING/JOINED`. All Phase-3/4/5 types (contracts, payments, subscriptions, claims, deposits, selections — 29 types) have full backend preference support (default settings, DB upsert, service methods) but **no UI row to change them** — users can never opt out of, say, `CLAIM_FILED` or `PAYOUT_COMPLETED` emails through this screen. This is a straightforward incomplete-UI gap, not a missing backend.
- `pushPermissionGranted` state defaults to `true` before the `useEffect` corrects it from `Notification.permission`, so there's a one-render flash where the "push requires permission" hint is hidden even when permission was never granted.
- The v1 mobile API (`PUT /api/v1/notifications/preferences`) exposes the same update capability generically (accepts any `eventType` string, cast at the type level) so all 39 types are settable via API even though the web UI only surfaces 10.

### Notifications UI (`src/components/notifications/`)

- `NotificationBell` — bell icon + unread badge, subscribed to `/api/notifications/stream`, updates the badge purely from `unread_count` SSE messages (does not increment locally when new notification items arrive over SSE — only reacts to the count events).
- `NotificationPopover` — fetches the latest 20 notifications on open (not SSE-driven, a fresh `getNotifications` call each time the popover opens), "Mark all as read" button with optimistic local state update.
- `NotificationItem` — click marks as read (if unread) then does a full `window.location.href` navigation to `notification.link` (a hard navigation, not a Next.js router push — page will fully reload). Icon selection is a coarse `type.startsWith("BOOKING_")` / `=== "NEW_MESSAGE"` / `startsWith("SUB_AGENT_")` / else-Calendar — meaning all 29 Phase 3-5 notification types (payments, contracts, claims, selections, subscriptions) fall through to the generic Calendar icon; there's no dedicated icon mapping for any of them.

### Push notifications (`src/modules/push/`)

- **Data model**: `PushSubscription` (`userId`, `endpoint`, `p256dh`/`auth` keys, `tokenType`: `"WEB"`|`"EXPO"`, `platform`, unique on `userId`+`endpoint`).
- **Web push**: uses the `web-push` library with VAPID keys from env (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`); if any of the three env vars is missing, `webpush.setVapidDetails` is never called and web-push sends are silently skipped (graceful degrade, no error surfaced).
- **Expo push**: uses `expo-server-sdk`, chunks messages via `expo.chunkPushNotifications`, handles both channels in `sendToUser` — queries all of a user's subscriptions, splits by `tokenType`, sends to each transport, and self-heals by deleting subscriptions that come back `410`/`404` (web) or `DeviceNotRegistered` (Expo).
- **Subscribe flow (web)**: `PushPermissionBanner` (`src/components/pwa/push-permission-banner.tsx`) — a contextual opt-in banner that only appears after the user's 2nd visit (tracked via `localStorage` visit counter, presumably incremented by a separate `PwaManager`), detects iOS (shows "Add to Home Screen first" copy since Safari doesn't support standard web push without PWA install), requests `Notification.requestPermission()`, subscribes via `PushManager.subscribe` with the VAPID key converted from URL-safe base64, and posts the subscription to `subscribeToPush` (`push.actions.ts`) which upserts a `PushSubscription` row via `pushService.subscribe`. Dismissible, remembered in `localStorage`.
- **Subscribe flow (mobile/Expo)**: `POST /api/v1/push/subscribe` (`src/app/api/v1/push/subscribe/route.ts`) accepts a discriminated `zod` union (`WEB` schema vs `EXPO` schema validating `ExponentPushToken[...]` format + `ios`/`android` platform), dual-authenticates via Supabase cookie or Bearer token (for native app clients), and routes to `pushService.subscribe` or `pushService.subscribeExpo` accordingly. **There is no server action equivalent for Expo subscribe** — `pushService.subscribeExpo` is only reachable through this one REST route, not through `push.actions.ts` (which only exposes the web `subscribeToPush`/`unsubscribeFromPush`/`getVapidPublicKey` actions). This is expected/correct given Expo tokens only come from a native app, not the Next.js web client.
- **Service worker** (`public/sw.js`): deliberately does no caching (comment: "Push notifications only"). Handles `push` (parses JSON payload, shows a `Notification` via `registration.showNotification` with icon/badge/vibration/tag/`renotify`, and calls `navigator.setAppBadge` if a badge count was included) and `notificationclick` (focuses an existing window matching the origin and navigates it, or opens a new window, to the notification's `url`). Registered in `src/app/layout.tsx` via `navigator.serviceWorker.register('/sw.js')`.
- **Delivery trigger**: only `notificationsService.notify` sends push (never `.create` alone), and only when `preference.pushEnabled` is true for that event type **and** the in-app notification was actually created (see coupling note above). Actual delivery is fire-and-forget from the caller's perspective — `notify()` awaits it, but nothing retries a failed push beyond web-push's own transient-failure behavior; permanent failures (410/404/DeviceNotRegistered) self-prune the subscription as noted.
- `hasSubscription(userId)` exists on the service but isn't called from any UI/action currently found — a small unused helper.

### Incomplete/stubs

- **`BOOKING_HOLD_WARNING`**: full plumbing exists (enum value, `DEFAULT_PREFERENCES` entry with push on, label, and a complete React email template `src/emails/booking-hold-warning.tsx` wired into `notifications.email.ts`) but it is **never triggered** — no job, webhook, or service calls it. The comment in the Prisma schema even documents intent ("24h / 6h before expiry") but the actual hold-expiry job (`booking-hold-timeout.job.ts`) goes straight from waiting to expiring with no intermediate warning step.
- **`SUB_AGENT_BOOKING`** and **`SUB_AGENT_JOINED`**: enum values, default preferences, and display labels exist; no email template, and no code anywhere creates either notification. Dead types.
- **`SELECTION_UPDATED`**: same pattern — enum/default/label exist, never triggered, and its dedicated email component (`src/emails/selection-updated.tsx`) is written but never imported into the email-sending switch.
- **`src/emails/availability-request.tsx`**: a written React email component that is never imported/used anywhere in the codebase (distinct from `availability-confirm.tsx`, which is used).
- **`message/thread-created` Inngest event**: emitted by `messagingService.createThread` but has zero subscribers — starting a conversation thread produces no notification to the owner; they only find out once the agent actually sends a first message (`message/sent` → `NEW_MESSAGE`).
- **Message search UI**: `messagingService.searchMessages` / `messagingQueries.searchMessages` (real DB full-text-ish search across message content and attachment filenames) is fully built and exposed as a server action, but the `Inbox` component's search box does not call it — it only filters the already-fetched thread list summaries client-side. The backend search capability is effectively unreachable from the product.
- **`getOrCreateThread` action**: documented in its own comment as "convenience action for the booking detail page 'Message Owner' button" — that button does not exist anywhere in the codebase; the action (and the "start conversation" affordance implied by `Inbox`'s unused `showStartConversation` prop) is not wired to any UI.
- **Notification preferences UI only covers 10/39 event types**: the settings screen (`notification-preferences.tsx`) hardcodes a 10-item `EVENT_TYPE_ORDER`; the 29 Phase 3-5 notification types (contracts, payments, subscriptions, claims/deposits, selections) have full backend preference support but no UI control on the web app (only reachable by directly calling the v1 REST API).
- **Notification icons**: `NotificationItem`'s `getIconForType` only special-cases `BOOKING_*`, `NEW_MESSAGE`, and `SUB_AGENT_*` prefixes; all 29 later-phase types render the generic Calendar icon.
- **`archiveThread` action** has no thread-membership authorization check, unlike every sibling messaging action (`sendMessage`, `getThread`, `markAsRead` all verify agent/owner access first).
- **Duplicate payment notifications**: the same `booking/paid` event drives two independent Inngest functions — `onBookingPaid` (`BOOKING_PAID`, in-app only, owner) and `onPaymentReceived` (`PAYMENT_RECEIVED`, in-app+email, agent+owner) — resulting in the owner getting two separate notification rows for one payment event, from two overlapping enum types.
- **`pushService.hasSubscription`** and **`pushService.subscribeExpo`-via-server-action**: the former is defined but has no caller anywhere; the latter only exists via the raw REST route, not the `"use server"` actions file (consistent with Expo-only-from-native-app, but worth noting as an asymmetry with the web subscribe path).
- **`MessageThread.bookingId` is nullable in the Prisma schema** ("nullable for general inquiries" per the schema comment) but `createThreadSchema` requires a UUID `bookingId` and `messagingService.createThread` always requires an existing booking with a matching agent — there is no code path that ever creates a booking-less "general inquiry" thread, despite the data model supporting it.

**Key files**: `src/modules/messaging/{messaging.service,messaging.queries,messaging.actions,messaging.schema,messaging.types}.ts`, `src/modules/notifications/{notifications.service,notifications.queries,notifications.actions,notifications.email,notifications.types}.ts`, `src/modules/push/{push.service,push.actions,push.types}.ts`, `src/shared/sse/{stream.ts,use-event-source.ts}`, `src/components/messaging/*.tsx`, `src/components/notifications/*.tsx`, `src/components/pwa/push-permission-banner.tsx`, `public/sw.js`, `src/app/api/messages/stream/[threadId]/route.ts`, `src/app/api/notifications/stream/route.ts`, `src/app/api/v1/{messaging,notifications,push}/**`, `src/jobs/*.job.ts` (trigger logic), `src/app/api/inngest/route.ts` (job registration), `prisma/schema.prisma` (`MessageThread`, `Message`, `MessageAttachment`, `Notification`, `NotificationPreference`, `PushSubscription`, `NotificationType`).

---

## Collections, Selections & Clients

### Collections vs. Selections — the core distinction

Two entirely separate models exist and are not related to each other in the schema:

- **Collection** (`prisma/schema.prisma` `model Collection`/`CollectionItem`) — a private, internal shortlist. Agent-only, never shared, no slug, no public route, no client identity attached. Just `name`, `description`, and a set of `CollectionItem` (property + agent notes). Used purely to organize saved properties (e.g., "Smith Family — Bali candidates") before building a real client-facing Selection.
- **Selection** (`model Selection`/`SelectionVilla`) — the client-facing sales proposal. Has a `slug` (public short link), a named `clientName`/`clientEmail`, a `checkIn`/`checkOut` date range, a `status` lifecycle (`DRAFT → ACTIVE → ARCHIVED`), agent branding applied at render time, and per-villa state (`PENDING/CONFIRMED/UNAVAILABLE/REMOVED`) plus view/favorite/booking-request tracking.

Collections have no export, no sharing, no client interaction whatsoever — confirmed by reading `src/app/(agent)/agent/collections/page.tsx` and `collections.service.ts`: `addProperty`/`removeProperty`/`delete` all just verify `collection.agentId === agentId` and mutate `CollectionItem` rows. There is no code path from Collection → Selection (no "convert collection to selection" action exists).

Files: `src/modules/collections/collections.{schema,types,service,queries,actions}.ts`, `src/app/(agent)/agent/collections/`.

### Building a Selection (agent side)

An agent creates a Selection via `CreateSelectionForm` (`src/components/selections/create-selection-form.tsx`) → `createSelectionAction` → `selectionsService.createSelection`. Required: client name (2–200 chars), client email (validated + lowercased), check-in/check-out (checkout must be strictly after checkin, enforced by a zod `.refine`), optional cover note (≤2000 chars). Creating a Selection also calls `clientsService.findOrCreateByEmail`, upserting a `Client` record (see CRM section below) and linking `selection.clientId`.

Adding villas (`AddVillaDialog` → `addVillaAction` → `selectionsService.addVillaToSelection`, in `src/modules/selections/selections.service.ts`):
- Verifies the agent owns the selection.
- Rejects duplicate property IDs (`unique([selectionId, propertyId])` at the DB level too).
- Checks live availability via `CalendarDay` (sparse storage: no `BOOKED/BLOCKED/ICAL_BLOCKED` row for any night in range = available).
- Computes a **price snapshot** at add-time: walks every night in the stay, finds the matching `Season` by date range, sums nightly rates using `Decimal.js` (falls back to the lowest season price for any night with no matching season) — `computeTotalStayPrice()`, duplicated verbatim in both `selections.service.ts` and `selection-pdf-generation.job.ts`.
- Sets `SelectionVilla.status = CONFIRMED` if calendar shows available, else `PENDING` and fires `selection/villa-added-pending` to notify the property owner by email + in-app notification, asking them to confirm via `POST /api/selections/villa/[id]/confirm` (owner-authenticated, verifies `userProfile.id === property.ownerId`, only allows `PENDING → CONFIRMED`, accepts an optional `confirmedPrice` override).
- Villas can be removed (soft-delete: status set to `REMOVED`, never physically deleted, so it's excluded from every agent/public query via `status: { not: "REMOVED" }` filters).
- Agent per-villa notes (≤1000 chars, auto-saves on blur) and a whole-selection cover note (≤2000 chars, auto-saves on blur).
- Sort order is append-only (`sortOrder = villas.length` at insert time) — there is no drag-to-reorder UI or action anywhere in `selection-villa-manager.tsx`.

Publishing (`publishSelectionAction` → `selectionsService.publishSelection`): flips `DRAFT → ACTIVE` **only if at least one `CONFIRMED` villa exists**; otherwise throws. On publish, fires `selection/pdf-requested` to pre-generate the PDF. Once `ACTIVE`, the agent gets Copy Link / Preview / Archive / Download-or-Generate-PDF / Duplicate buttons (`selection-detail-client.tsx`). Archiving is one-way in the UI (no "reactivate" button, though `updateSelectionSchema` technically accepts any of the three enum values so a hypothetical action could).

**Duplicate** (`duplicateSelectionAction`): clones a selection for a new client — copies checkIn/checkOut/coverNote and every non-removed villa, but resets every villa to `PENDING` (forces re-confirmation by owners even if the original was `CONFIRMED`, since price/availability may have changed for the new client's dates — though note the same `checkIn`/`checkOut` is actually reused verbatim from the original, not re-picked, so "duplicate" really means "same dates, different client name/email").

There is also a bulk one-shot flow (`createAndSendSelectionAction` in `selections.actions.ts`, invoked from `src/components/search/send-selection-dialog.tsx` on the search page) that creates a selection, adds a list of property IDs in one call (silently skipping ones that fail), auto-publishes, and optionally emails the client immediately — this is the "Send to Client" button from search results.

Files: `src/modules/selections/selections.{schema,types,service,queries,actions}.ts`, `src/components/selections/{create-selection-form,selection-detail-client,selection-villa-manager,add-villa-dialog}.tsx`.

### Public sharing — `/s/[slug]`

The slug is a 10-char nanoid over `[0-9a-z]` (3.6 trillion combinations), generated with collision-retry (3 attempts, catches Prisma `P2002`). `src/app/s/[slug]/layout.tsx` + `page.tsx` render a chrome-free, mobile-first page (`min-h-[100dvh]` for WhatsApp in-app browser compatibility) with no authentication.

Query/render rules (`selectionsService.getPublicSelection`, cached 5 min via `unstable_cache` tagged `selection-${id}`, invalidated on every mutation via `updateTag`):
- Only `ACTIVE` selections are served publicly — `DRAFT`/`ARCHIVED` return `notFound()`.
- Villas are filtered to `CONFIRMED` (shown normally, sorted **ascending by live total price**) and `UNAVAILABLE` (shown in a separate "No Longer Available" section, greyscaled photo, red badge, no expand/favorite/book actions). `PENDING` and `REMOVED` villas are invisible to the client — a client never sees a villa still awaiting owner confirmation.
- Pricing shown is **recomputed live** at render time from current `Season` data for `CONFIRMED` villas (not the stale add-time snapshot) — so if the owner changes rates after adding to the selection, the client sees updated pricing automatically. `UNAVAILABLE` villas keep their frozen snapshot price (no seasons refetched).

Branding is applied via CSS custom properties (`--brand-primary/secondary/accent`) read from `AgentBrand`, with the agent's chosen Google Font dynamically `<link>`-loaded only if not the default "Inter" (single extra request). Header (`SelectionHeader`) renders either a full-bleed cover-image hero with gradient-overlaid text, or a simple logo+tagline+title block if no cover image is set. Footer always shows "Powered by NexLet" plus the agent's optional custom footer text underneath — the platform attribution is not removable by an agent, even on the "Pro tier" custom-domain field (which itself is unused, see Incomplete section).

Files: `src/app/s/[slug]/{layout,page}.tsx`, `src/components/selections/{selection-header,selection-cover-note,selection-footer,selection-villa-card,selection-villa-expanded}.tsx`.

### Client-side interaction

**View tracking (`SelectionView`)** — `src/app/s/[slug]/view-tracker.tsx` fires a fire-and-forget `POST /api/selections/[id]/views` on mount (guarded by a `useRef` so React strict-mode double-mount doesn't double count). The endpoint (`src/app/api/selections/[id]/views/route.ts`) fingerprints the visitor as `sha256(ip:user-agent).slice(0,16)` and **de-dupes views from the same fingerprint within a rolling 1-hour window** (a genuine anonymous unique-visit heuristic, not a raw hit counter — matches `selectionsQueries.getViewCount()` which counts distinct fingerprints, though this dedup helper is unused by the agent UI, which just shows `_count.views`, the raw row count, not the deduped count). Recording a new view fires `selection/viewed` → in-app-only notification to the agent ("X viewed your selection"), no email.

**Favorites (`SelectionFavorite`)** — heart icon (`ClientFavoriteButton`) with optimistic toggle UI. `POST /api/selections/[id]/favorites` requires the posted `clientEmail` to case-insensitively match `selection.clientEmail` (403 otherwise) — this is the entire "authentication" model for the public page: knowledge of the slug + being the named client. True toggle (unique constraint `[selectionId, propertyId, clientEmail]`; race-condition-safe via catch-P2002-then-treat-as-favorited). Only *favoriting* (not unfavoriting) fires an agent notification (in-app + no email) via `selection/villa-favorited`.

**Booking requests (`SelectionBookingRequest`)** — `ClientRequestBooking` opens a dialog with an optional 500-char message, then `POST /api/selections/[id]/request-booking`. Business rules: selection must be `ACTIVE`; email must match; the target villa must currently be `CONFIRMED` in that selection; duplicate pending requests for the same selection+property+client are rejected with 409. **Explicitly does NOT create a `Booking` record** — the code comment states "the request goes to agent first (locked decision — agent approves before it reaches the owner)". It only inserts a `SelectionBookingRequest` row with `status: PENDING` and fires `selection/booking-requested`, which sends both an in-app notification and an email to the agent.

Files: `src/components/selections/{client-favorite-button,client-request-booking}.tsx`, `src/app/api/selections/[id]/{views,favorites,request-booking}/route.ts`, `src/jobs/selection-notifications.job.ts`.

### Branded PDF proposal export

Fully implemented, not a stub. Trigger points: automatically on `publishSelection`, or on-demand via `GET /s/[slug]/pdf` (agent "Generate PDF" button, or the public download link shown when `selection.pdfUrl` exists). The route proxies the R2-hosted PDF with a `Content-Disposition: attachment` header if one exists; if missing/stale (fetch fails), it fires `selection/pdf-requested` and returns `202` so the client can poll (the agent UI polls via a hardcoded 5s `setTimeout` then `router.refresh()` — not a real completion webhook).

Generation (`src/jobs/selection-pdf-generation.job.ts`, Inngest, 2 retries): fetches `CONFIRMED`-only villas, pre-downloads every hero photo + the agent logo to in-memory Buffers first (explicitly to dodge `@react-pdf/renderer` CORS/timeout issues with remote `Image` — 10s timeout per image, silently falls back to a 1×1 transparent PNG placeholder on failure), recomputes live pricing from current seasons, renders via `@react-pdf/renderer` (`selection-pdf.tsx`), uploads to R2 at `selections/{selectionId}/selection-{slug}.pdf`, and writes `pdfR2Key`/`pdfUrl` back onto `Selection`.

The template itself carries real branding: agent logo, tagline, per-villa hero photo/price/dates/bed-bath-guest stats/top-8-amenities/agent notes, the cover note, and the agent's custom footer text plus a fixed "Powered by NexLet" line and "Contact your agent to proceed" (no self-serve payment/checkout link in the PDF — booking still routes through the agent). Font: a curated whitelist of 16 Google Fonts (`FONT_TTF_URLS`) is registered into `@react-pdf/renderer` by TTF URL; any font outside that list silently falls back to Helvetica.

Files: `src/modules/selections/templates/{selection-pdf,selection-pdf-styles}.ts(x)`, `src/jobs/selection-pdf-generation.job.ts`, `src/app/s/[slug]/pdf/route.ts`.

### Agent branding (`AgentBrand`)

One brand record per agent (`upsert`-based, applies to *every* selection and the PDF uniformly — no per-selection or per-client branding override exists). Settings UI (`brand-settings-form.tsx` + live phone-frame `brand-preview.tsx`) covers: logo upload (image only, ≤2MB, → R2), cover image (≤5MB/10MB depending which limit you hit — the action enforces 10MB server-side but the form enforces 5MB client-side, a minor mismatch), 3 hex colors validated by regex both client- and server-side, a font picker constrained to the same 16-font curated list used by the PDF, a tagline (≤200 chars), and footer text (≤500 chars). Everything auto-persists through `updateBrandSettingsAction`.

Files: `src/modules/selections/branding.{schema,types,service,queries,actions}.ts`, `src/components/selections/{brand-settings-form,brand-preview,color-picker,font-selector}.tsx`, `src/app/(agent)/agent/settings/branding/`.

### Client entity — CRM depth actually implemented

`Client` (`prisma/schema.prisma`) is a light, agent-agnostic dedup registry keyed on unique lowercase `email`, not a rich CRM record. `clientsService.findOrCreateByEmail` (`src/modules/clients/clients.service.ts`) is called automatically whenever a Selection is created/duplicated or (elsewhere) a booking flow runs: on upsert it always refreshes `name`, conditionally refreshes `phone` if provided, and preserves `createdByAgentId` as whichever agent first registered that email (subsequent agents interacting with the same client email reuse — and silently rename — the same `Client` row; there's no per-agent client list, since `createdByAgentId` isn't filtered on anywhere except an index).

`ClientProfile` (via `getClientProfile`) aggregates: booking count, selection count, last booking date, and any `GuestFlag` rows (party/damage/rule_violation/noise/family/business/corporate tags with free-text notes, keyed by `guestEmail` across bookings) — this is real, useful data. **However this profile view is gated to `UserRole.OWNER`/`ADMIN` only** (`getClientProfileAction` in `clients.actions.ts`), surfaced solely inside the owner's booking-detail page (`src/app/(owner)/owner/bookings/[id]/page.tsx`). There is a separate unauthenticated-role-check REST endpoint `GET /api/v1/clients/[id]` that also exposes it, and a `POST /api/v1/clients` (agent-role-gated) for programmatic find-or-create — likely a partner/integration API, not used by any UI component in the repo.

Files: `src/modules/clients/clients.{schema,types,service,queries,actions}.ts`, `src/app/api/v1/clients/{route,[id]/route}.ts`.

### Incomplete/stubs

- **No agent-facing "Clients" page exists at all.** There is nothing under `src/app/(agent)/` for browsing, searching, or editing an agent's own client list — despite this being CRM-like data an agent keeps. The only client data agents interact with is indirectly, via typing a name+email into the selection-creation form. Only owners/admins can view `ClientProfile`.
- **`Client.notes` (`String? @db.Text` on the `Client` model) is dead schema.** Never set by `findOrCreateByEmail` (the schema `findOrCreateClientSchema` doesn't even accept a `notes` field), never read by `getClientProfile`, never rendered anywhere. Pure unused column — the only "notes" actually surfaced to a human are `GuestFlag.notes`, a different model.
- **`SelectionBookingRequest` has no agent review UI or action.** The schema defines `agentReviewedAt`, `agentNotes`, `bookingId` (link to the eventual real `Booking`), and a `PENDING/APPROVED/DECLINED` status enum — but grepping the whole codebase turns up only the `POST /api/selections/[id]/request-booking` **creation** path. There is no server action, API route, or UI anywhere that lets an agent approve/decline a request or have it create an actual `Booking`. The public page correctly shows "Requested" (disabled button) once a request is pending, but the agent side never displays the list of pending requests at all — not on the selection detail page, not in notifications beyond a generic "X wants to book" toast/email that deep-links to `/agent/selections/{id}`, which itself renders no booking-request list (`SelectionDetail`'s type declares `bookingRequests`/`favorites` relations, but the actual query used by the page, `selectionsQueries.getById`, never fetches them — only aggregate `_count.views`/`_count.favorites`). This is the single biggest gap in the described "request a booking directly off a selection" flow: the request genuinely goes nowhere actionable today.
- **Likely bug, not just incomplete:** `POST /api/selections/[id]/favorites` sends the Inngest event `selection/villa-favorited` with `{ selectionId, propertyId, clientEmail, isFavorited, agentId }` — no `clientName`. The consuming handler `onSelectionVillaFavorited` (`src/jobs/selection-notifications.job.ts`) destructures `clientName` from `event.data` and interpolates it into the notification title/message ("`${clientName} favorited a villa`"). Since it's never sent, every favorite notification an agent receives literally reads "undefined favorited [property]".
- **`AgentBrand.customDomain` / `customDomainVerified`** ("Pro tier only" per the schema comment) are defined columns with defaults in `BrandWithDefaults`, but there is no action, form field, or verification flow anywhere in the codebase to set or check a custom domain. Every selection is served at `nexlet.../s/{slug}` regardless of tier.
- **Villa reordering within a Selection is append-only.** `sortOrder` is set once at insert time (`selection.villas.length`); no drag handle, no reorder action exists in `selection-villa-manager.tsx` or `selections.actions.ts`, despite `sortOrder` being a first-class DB/query-sort field.
- **PDF generation completion is polled blindly.** The agent's "Generate PDF" button (`selection-detail-client.tsx`) fires the request then does a flat `setTimeout(..., 5000)` before refreshing — no real completion signal, so a slow render (many villas/images) can leave the agent clicking "Download" before the file exists, silently falling into the 202/regenerate branch again.
- **File-size limit mismatch on cover image upload:** client-side validates ≤5MB (`brand-settings-form.tsx`) while the server action `uploadCoverImageAction` allows ≤10MB — inconsistent but not exploitable (server is the binding limit, client is just stricter than necessary; not a security gap, just sloppy).

---

## Admin, Auth & Infrastructure

### Authentication (Supabase)

NexLet uses Supabase Auth via `@supabase/ssr`, with three client constructors for three contexts:
- `src/shared/auth/supabase/server.ts` — cookie-based client for Server Components/Actions/Route Handlers (uses `next/headers` cookies; swallows `setAll` errors in read-only RSC contexts with a comment that middleware handles refresh).
- `src/shared/auth/supabase/client.ts` — browser client for client components (sign-out, OAuth kickoff).
- `src/shared/auth/supabase/admin.ts` — service-role client (`SUPABASE_SERVICE_ROLE_KEY`) for privileged operations; not currently invoked anywhere in the reviewed admin/auth code paths (grep shows only the factory function, no callers in scope).

**Concrete flows implemented:**
1. **Email/password sign-up** (`src/app/(auth)/sign-up/[[...sign-up]]/page.tsx`) — collects first/last name, email, password (client-side `minLength={6}`), and a role toggle (`OWNER` or `AGENT` only — no ADMIN option, obviously). Calls `supabase.auth.signUp` with `options.data` metadata carrying `firstName`, `lastName`, `role`. Shows a "check your email" confirmation screen; no client-side password-strength/complexity check beyond the 6-char HTML minlength.
2. **Email/password sign-in** (`src/app/(auth)/sign-in/[[...sign-in]]/page.tsx`) — `signInWithPassword`, then on success fires `/api/auth/me` to cache `{email, role, name}` into `localStorage` under `ACCOUNTS_STORAGE_KEY` (dedup by email+role, max 10 entries) — this powers a "switch accounts" quick-picker, not a real multi-session mechanism. Supports `?email=` prefill for account switching UX.
3. **Google OAuth** (`src/shared/components/google-oauth-button.tsx`) — `signInWithOAuth({ provider: "google", redirectTo: "${origin}/callback" })`. This is the **only** third-party provider wired up — no Apple/Facebook/etc., no `signInWithOtp` (magic link) anywhere in the codebase (grepped).
4. **OAuth/session callback** (`src/app/(auth)/callback/route.ts`) — exchanges the `code` for a session, then branches: if a `UserProfile` already exists → `/dashboard` (idempotent for returning users); if new user with `role` in Supabase `user_metadata` (i.e., came from the email sign-up form) → creates the `UserProfile` immediately (role forced to `AGENT` or else `OWNER`) and redirects to `/dashboard`; if new OAuth user with **no** role metadata → redirects to `/onboarding/role` for manual role selection. Profile creation is wrapped in try/catch to tolerate a race where a concurrent request already created it.
5. **Role selection onboarding** (`src/app/onboarding/role/`) — `page.tsx` redirects away if a profile already exists (double-submit guard) and pre-fills name from OAuth `full_name`/`name` metadata; `actions.ts` (`selectRole`) validates role ∈ `{OWNER, AGENT}` and non-empty first name, then `upsert`s the profile with `update: {}` (a no-op on conflict — deliberately won't overwrite an existing profile).
6. **Sign-out** (`src/app/api/auth/sign-out/route.ts`) — POST-only, calls `supabase.auth.signOut()`, then redirects to a caller-supplied `?redirect=` param, but only if it starts with `/` and not `//` (open-redirect guard).
7. **`/api/auth/me`** — returns `{firstName, role, email}` for the current session or 401/404; used purely for the localStorage account-switcher.

**Dual-mode API auth**: `getApiAuthContext(req)` in `src/shared/auth/guards.ts` tries cookie auth first, then falls back to an `Authorization: Bearer <token>` header (for the mobile app under `apps/mobile`) via `supabase.auth.getUser(token)`.

### Role-Based Access Control

- **Roles**: a flat 3-value enum, `UserRole.OWNER | AGENT | ADMIN` (`prisma/schema.prisma` + `src/shared/auth/roles.ts`). Role lives on `UserProfile.role`, looked up by `authUserId` on every guard call (no caching/JWT claims — a fresh DB read each time).
- **`ROLES` permission map** in `roles.ts` defines fine-grained permission strings per role (e.g. `"agent:review"`, `"agent:revoke"`, `"admin:access"`, `"listing:create"`) — **this map is dead code**: grepped the whole `src/` tree and it is never imported or referenced anywhere outside its own declaration. All real authorization checks use the coarse `UserRole` enum directly, never these permission strings.
- **Guard functions** (`src/shared/auth/guards.ts`):
  - `getAuthContext()` — throws if unauthenticated or profile missing; used inside server actions/handlers that already trust the caller is logged in.
  - `requireRole(role | role[])` — redirects to `/sign-in` if unauthenticated, `/sign-in` if no profile, `/` if role doesn't match. Used at the top of every admin page/layout.
  - `requireAuth()` — any authenticated role; redirects to `/sign-in` otherwise.
  - `getCurrentUser()` — non-throwing variant for UI display (sidebar/account menu).
- **`createAction()`** (`src/shared/utils/create-action.ts`) and **`createApiHandler()`** (`src/shared/utils/create-api-handler.ts`) are the two central factories that wrap ~all server actions and `/api/v1/*` routes respectively. Both implement role checks identically: `if (!roles.includes(ctx.role) && !ctx.isAdmin) → reject`. **This means `ADMIN` implicitly passes every role-gated action/route in the app**, including ones scoped to `UserRole.OWNER` or `UserRole.AGENT` only — there is no per-action override to exclude admins. `createApiHandler` returns 403/401/400/500 with a typed `{success, error, code}` envelope; `createAction` returns `ActionResult` `{success, error}` for use with `useActionState`.
- **Middleware** (`src/middleware.ts`) only enforces **authentication presence**, not role: it refreshes the Supabase session cookie and redirects to `/sign-in` for any non-public route when there's no `user`. It does **not** check role for `/admin/*` — that enforcement happens entirely in `src/app/(admin)/layout.tsx` via `await requireRole(UserRole.ADMIN)`, which every admin page inherits (dashboard, agent detail, property detail all also independently call `requireRole(UserRole.ADMIN)` again, redundantly but harmlessly). Public-route allowlist is a mix of exact (`/`) and prefix matches (`/sign-in`, `/sign-up`, `/listings/`, `/s/`, `/api/ical/`, `/api/inngest`, `/api/auth/sign-out`, `/api/webhooks/`, `/api/selections/`, `/checkout/`, `/api/checkout/`, `/callback`). The middleware matcher excludes static assets and always runs for `/api|/trpc`.
- **Test coverage**: `src/shared/auth/guards.test.ts` is a scaffold-only stub — it contains one placeholder assertion (`expect(true).toBe(true)`) and a TODO list of the tests that should actually exist for `getApiAuthContext`'s dual-mode auth. No real unit test exercises any guard function.

### Admin Dashboard — actual capabilities

The admin web surface is intentionally minimal: **one dashboard route with two queue tabs, plus two detail-drill-down routes.** Confirmed by reading the nav config (`ADMIN_SECTIONS`/`ADMIN_TABS` in `src/components/layout/sidebar-nav.tsx`) and the full file listing of `src/app/(admin)/` — there is no user management page, no analytics/stats page, no settings page, no audit log, no impersonation, and no feature-flag UI anywhere in the admin route group.

**1. Agent application review** (`src/modules/agents/`, wired into `/admin/dashboard?tab=agents` and `/admin/dashboard/agents/[id]`):
- Applications are created via `agentsService.submitApplication` — one per user (`AgentApplication.userId` is unique; duplicate submission throws "You have already submitted an application"). Validated by `agentApplicationSchema` (Zod): company name ≥2 chars, address ≥10 chars, optional URL for website, ≥1 year in business, an enum booking-volume bucket, ≥1 property type, and **2–3 references required** (each needs name/company/email/relationship).
- Admin actions, gated by `requireAdminAuth()` inside `agents.actions.ts` (checks `ctx.isAdmin`, throws if not):
  - **Approve** (`approveApplication`) — sets status `APPROVED`. Comment in the service notes `UserProfile.role` is already `AGENT` at signup; approval only flips the *application* status, which is what the agent-portal layout guard actually checks to grant access.
  - **Reject** (`rejectApplication`) — requires a non-empty `rejectionReason` (enforced both by `reviewApplicationSchema`'s Zod `.refine` and again by an explicit check in the action); reason is stored and shown back to the applicant.
  - **Revoke** (`revokeAgentAccess`) — sets status `REVOKED` with a hardcoded review note `"Access revoked by admin"`; UI only offers this when `status === APPROVED`.
  - **No status-machine enforcement in the service layer**: unlike the property review service (see below), `agentsService.approveApplication`/`rejectApplication`/`revokeAccess` do **not** check the application's current status before writing — `agentsQueries.updateStatus` is an unconditional update. The **UI** is the only thing preventing e.g. re-approving a `REVOKED` application (`canReview`/`canRevoke` booleans computed from status in `agents/[id]/page.tsx`), so a second admin action call (replay, race, or direct action invocation) can transition an application out of order.
  - **`UNDER_REVIEW` is a defined `ApplicationStatus` and appears throughout filters/badges/UI**, but nothing in the codebase ever sets an application's status to `UNDER_REVIEW` — it's only ever `PENDING` (on creation) → `APPROVED`/`REJECTED`/`REVOKED`. Dead status value for this entity (it's genuinely used elsewhere, for insurance `Claim.status`).
  - Detail page (`admin/dashboard/agents/[id]/page.tsx`) surfaces full application data: business credentials, insurance/license doc presence (just "Uploaded"/"Not provided" — no inline document viewer/download link rendered), track record, references, and a timeline (submitted/reviewed/reviewNote/rejectionReason).
- Dashboard list view: sortable by company/experience/submitted date, filterable by status, searchable by company name, with per-row dropdown actions (`View Details`, and `Approve`/`Reject` when pending, `Revoke Access` when approved) — `src/components/data-table/columns/agent-application-columns.tsx`.

**2. Property submission review** (`src/modules/admin/`, wired into `/admin/dashboard?tab=properties` and `/admin/dashboard/properties/[id]`):
- Explicit state machine (`admin.service.ts` docblock + enforced in code): `DRAFT → PENDING_REVIEW → APPROVED → PUBLISHED`, with a `CHANGES_REQUESTED` branch that loops the owner back to `PENDING_REVIEW` on resubmission (resubmission itself lives in `src/modules/listings/listings.service.ts`).
- **Approve** (`approveProperty`) — only legal from `PENDING_REVIEW`; throws a descriptive error naming the actual current status otherwise. Sets `status: APPROVED`, `reviewedAt: now`, optional `reviewNote`.
- **Publish** (`publishProperty`) — only legal from `APPROVED`; sets `status: PUBLISHED`, `publishedAt: now`. On success, calls `updateTag("properties")` in addition to per-listing tag invalidation, unlike approve/reject.
- **Request changes / reject** (`rejectProperty`, aliased as `requestChanges`) — only legal from `PENDING_REVIEW`; **requires** a non-empty `reviewNote` (checked in the service, throws "Review note is required..." otherwise) — sets `status: CHANGES_REQUESTED`.
- Unlike agent applications, property transitions **are** guarded in the service layer (`adminQueries.findPropertyById` + explicit status check before every mutation) — this is the more defensively-written half of the admin module.
- On every mutation, admin actions call `revalidatePath("/admin/dashboard")`, `revalidatePath("/listings/${id}")`, and `updateTag("listing-${id}")` (Next.js cache invalidation for the public listing page).
- Detail page (`properties/[id]/page.tsx`) is the richest admin view: photo gallery preview (hero badge), all description fields, seasons/pricing table, amenities, extra fees, staff services, and review history — essentially a read-only render of the full `Property` + relations for manual vetting before approval.
- Dashboard list view mirrors the agent table: sort/filter/search, per-row `Approve`/`Request Changes` (pending) or `Publish` (approved) actions — `src/components/data-table/columns/property-submission-columns.tsx`.
- Both flows share one confirmation-dialog UX in `admin-dashboard-client.tsx` (reject-agent / revoke-agent / request-changes all funnel through the same `DialogState` + `ResponsiveModal`, with "Confirm" disabled until a note is typed where required).

**3. Badge counts** — `adminService.getQueueCounts()` powers small numeric badges on the two tabs (pending agent count, pending property count), computed via two `prisma.count()` calls.

**4. Platform summary (revenue/totals) exists but is unused on the web**: `adminService.getPlatformSummary()` / `adminQueries.getPlatformSummary()` aggregate `pendingAgents`, `pendingProperties`, `totalAgents` (approved), `totalProperties`, `totalBookings`, and `totalRevenue` (sum of `Payment.amountCents`). The dashboard page's own comment states *"Per user decision: two operational queue tabs only — no analytics or stats counters"* — and indeed this summary is **only** consumed by `src/app/api/v1/admin/counts/route.ts` (the mobile-API surface), never rendered anywhere in `src/app/(admin)/`.

**5. "On behalf of" owner selector is backend-only**: `adminService.getOwners()` / `admin.actions.ts:getOwners()` fetch all `OWNER`-role profiles for what the code comments describe as an "admin concierge flow" (admin creating a listing for an owner). It's exposed as a server action and mirrored at `/api/v1/admin/owners`, but **no UI anywhere in `src/app/(admin)/` or `apps/mobile` calls it** — grepped both trees, zero consumers beyond the action/route/service/query chain itself.

### Trust & Safety — explicitly NOT an admin capability

There is a `src/modules/reputation/` module implementing guest-flagging and mutual ratings (`reputationService.flagGuest`, `rateUser`), but it is **entirely peer-to-peer between owners and agents on completed bookings** — flags/ratings are created by whichever party (owner or agent) was on the booking, with checks that the booking is `COMPLETED`, the rater is a real party to it, and no duplicate flag/rating per booking+user. There is **no admin-facing view, moderation queue, or override** for these flags anywhere in `src/app/(admin)/` or `src/modules/admin/` — admins cannot see, dispute, or clear a guest flag through the audited surface. (There is a separate, more fully-built `Claim`/dispute state machine in `src/modules/claims/` for booking disputes with an `UNDER_REVIEW` status and admin-adjacent resolution routes at `/api/v1/claims/[id]/resolve` and `/review`, but that's a claims/dispute feature, not a "flag this user for trust & safety" admin tool.)

### Rate Limiting (Upstash)

`src/shared/rate-limit/index.ts` — `@upstash/ratelimit` + `@upstash/redis`, sliding-window algorithm, four named limiters:

| Limiter | Threshold | Prefix | Actually used at |
|---|---|---|---|
| `webhookLimiter` | 100 req/min | `rl:webhook` | Stripe (`/api/webhooks/stripe`) and DocuSign (`/api/webhooks/docusign`) webhook handlers, keyed by IP |
| `apiLimiter` | 60 req/min | `rl:api` | **Defined, exported, never imported anywhere else in `src/`** — dead code; no authenticated route or server action applies it |
| `uploadLimiter` | 10 req/min | `rl:upload` | `/api/upload/presign`, keyed by Supabase user id |
| `publicLimiter` | 30 req/min | `rl:public` | Public/anonymous routes: checkout intent/deposit creation, iCal feed, and the public "selections" routes (favorites, views, request-booking, villa confirm) — keyed by IP via `getIp()` |

**Graceful degradation is the default, not the exception**: `createRedis()` returns `null` unless `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are both set; when `null`, every `createLimiter()` call also returns `null`, and `rateLimit(null, id)` always resolves `{success: true}` — i.e., **rate limiting silently no-ops** if those two vars aren't configured. Confirmed these two env vars are **not** present in `.env.example` and are **not** part of the validated `src/env.ts` schema at all (they're read straight off `process.env` in the rate-limit module, bypassing the app's own env validation) — so there's no forcing function to ever set them up; a fresh deploy following `.env.example` would run with rate limiting fully disabled everywhere, including the checkout/webhook/upload endpoints, with no warning.

`getIp()` reads `x-forwarded-for` (first entry) or `x-real-ip`, falling back to the literal string `"anonymous"` if neither header is present (meaning multiple truly-unidentifiable clients would share one rate-limit bucket).

None of the general-purpose `createAction`/`createApiHandler` factories apply any rate limiting — it is opt-in per route handler, manually, only in the handful of routes listed above. Server actions used by the admin dashboard (approve/reject/revoke/publish) have **no rate limiting at all**.

### File Storage (Cloudflare R2)

- **Client** (`src/shared/storage/r2-client.ts`) — lazily-constructed `S3Client` (region `"auto"`) pointed at `R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`; throws a clear configuration error if any are missing (no silent degradation here, unlike rate limiting). In `E2E_TEST_MODE`, `getR2Client()` returns a `Proxy` that throws on any property access, forcing tests through `getAdapter("r2")` instead — a deliberate anti-footgun.
- **Presigned upload generation** (`src/shared/storage/upload.ts`) — `generateUploadUrl({contentType, folder, propertyId?, bookingId?})` builds an object key as `${folder}/${propertyId ?? "general"}/${uuidv7()}` for `photos`/`documents`, or `evidence/${bookingId ?? "general"}/${uuidv7()}` for `evidence`; signs a `PutObjectCommand` with `getSignedUrl` and a **10-minute expiry**. Uses UUIDv7 (time-ordered) for keys.
- **Only one route exposes this**: `POST /api/upload/presign` (`src/app/api/upload/presign/route.ts`). Server-side validation actually enforced:
  - Requires an authenticated Supabase session (401 otherwise) — but performs **no ownership check**: any authenticated user of any role can request a presigned URL scoped to any `propertyId`/`bookingId` string they supply (including ones they don't own) — the endpoint only checks that the caller is logged in, not that they're the owner of that property or a party to that booking. Actual authorization for what those uploaded URLs get *attached to* would have to happen in the downstream save action.
  - Rate-limited via `uploadLimiter` (10/min) keyed by the caller's Supabase user id.
  - `folder` restricted to exactly `"photos" | "documents" | "evidence"`.
  - Content-type allowlist: `photos`/`evidence` → images only (jpeg/png/webp/avif/gif); `documents` → images + `application/pdf`.
  - `fileSize` is **required** and validated as a positive number ≤ 15MB (`MAX_FILE_SIZE = 15 * 1024 * 1024`) — note this is a client-declared size used only for pre-flight rejection; R2/S3 doesn't enforce it server-side at PUT time from what's in this code (the presigned `PutObjectCommand` doesn't set `ContentLength`), so a client could still upload a larger file than declared.
  - Returns `{uploadUrl, key, publicUrl}` where `publicUrl` is constructed client-side as `${env.R2_PUBLIC_URL}/${key}` (no signature on the public URL — R2 bucket is presumed public-read for hosted assets).

### DB / error utilities

- `src/shared/db/client.ts` — singleton Prisma client using the `PrismaPg` driver adapter over `DATABASE_URL`, with the standard Next.js dev-mode `globalThis` caching trick to survive hot-reload without exhausting connections.
- `src/shared/db/errors.ts` — one helper, `isPrismaError(error, code)`, a type-guard for Prisma error codes (documents `P2002` unique-violation and `P2025` not-found/optimistic-lock-failure as the common ones). Small, single-purpose, no over-engineering here.

### Incomplete / stubs

- **`apiLimiter` (60 req/min authenticated-endpoint limiter) is defined but never used anywhere** — `src/shared/rate-limit/index.ts`. No authenticated server action or `/api/v1/*` route applies rate limiting; only the specific webhook/upload/public routes listed above opt in manually.
- **Rate limiting is silently disabled by default**: `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are absent from `.env.example` and from the validated `src/env.ts` schema, so a standard setup runs with no rate limiting anywhere, with no warning surfaced.
- **`ROLES` fine-grained permission map** (`src/shared/auth/roles.ts`) — declared with per-role permission strings (`"agent:review"`, `"listing:create"`, `"admin:access"`, etc.) but never consumed anywhere in the codebase; all real gating uses the 3-value `UserRole` enum only.
- **`PropertyStatus.SUSPENDED`** exists in the Prisma schema and has a badge label defined in both admin and owner UI utils (`src/shared/utils/property-status.ts`), but there is **no service method, action, or UI control anywhere that transitions a property to `SUSPENDED`** — an admin cannot pull a published listing down through any code path in this repo.
- **Agent application status transitions have no service-layer state-machine guard** (approve/reject/revoke on `AgentApplication` will overwrite any prior status unconditionally) — contrast with `Property` review, which does enforce legal prior-state checks. Only the client UI (`canReview`/`canRevoke` booleans) prevents illegal transitions in practice.
- **`ApplicationStatus.UNDER_REVIEW`** is modeled, filterable, and rendered with its own badge, but no code path ever sets an `AgentApplication` to that status — applications only ever go `PENDING → APPROVED|REJECTED|REVOKED`.
- **Admin "concierge" owner selector** (`adminService.getOwners()`, `/api/v1/admin/owners`) — fully implemented backend (query + service + server action + mobile REST route) with **zero UI consumers** anywhere in the web admin app or the mobile app; dead capability from the frontend's perspective.
- **Platform-wide summary/revenue stats** (`adminService.getPlatformSummary()`) — fully implemented and exposed via `/api/v1/admin/counts` (mobile), but deliberately not surfaced in the web admin dashboard (per an explicit code comment recording that decision) — so there is currently no revenue/booking-totals view in the web admin UI at all.
- **No trust & safety moderation surface for admins** — guest flags and owner/agent ratings (`src/modules/reputation/`) are fully peer-to-peer with no admin visibility, review queue, or override anywhere in the audited admin code.
- **`src/shared/auth/guards.test.ts`** is an explicit placeholder ("test scaffold exists ... Full integration tests ... will be added when the Supabase test utilities are set up in Phase 2") with a single `expect(true).toBe(true)` and a TODO list of the real test cases (`getApiAuthContext` cookie-vs-Bearer fallback, unauthorized paths, missing-profile path) — none of which are implemented.
- **No automated tests found** for `middleware.ts`, `src/shared/rate-limit/index.ts`, `src/shared/storage/r2-client.ts`, or `src/shared/storage/upload.ts` (only a `test-adapters/r2.test-adapter.ts` mock exists for use under `E2E_TEST_MODE`, not a unit test of the real modules).
- **Presigned upload endpoint has no resource-ownership check** — any authenticated user (regardless of role) can mint an upload URL scoped to an arbitrary `propertyId`/`bookingId`, and the client-declared `fileSize` used for the 15MB cap is not enforced by R2 itself at PUT time (no `ContentLength` set on the presigned command).

**Key files referenced**: `src/middleware.ts`; `src/shared/auth/{guards.ts,guards.test.ts,roles.ts,supabase/{server,client,admin}.ts}`; `src/app/(auth)/{callback/route.ts,sign-in/[[...sign-in]]/page.tsx,sign-up/[[...sign-up]]/page.tsx,error.tsx}`; `src/app/onboarding/role/{page.tsx,actions.ts,role-selection-form.tsx}`; `src/app/api/auth/{me,sign-out}/route.ts`; `src/shared/components/google-oauth-button.tsx`; `src/app/(admin)/{layout.tsx,error.tsx,admin/dashboard/{page.tsx,admin-dashboard-client.tsx,loading.tsx,agents/[id]/{page.tsx,agent-detail-actions.tsx},properties/[id]/{page.tsx,property-detail-actions.tsx}}}`; `src/modules/admin/{admin.actions.ts,admin.service.ts,admin.queries.ts}`; `src/modules/agents/{agents.actions.ts,agents.service.ts,agents.queries.ts,agents.schema.ts}`; `src/shared/utils/{create-action.ts,create-api-handler.ts,property-status.ts,agent-application-status.ts}`; `src/components/data-table/columns/{agent-application-columns.tsx,property-submission-columns.tsx}`; `src/components/layout/sidebar-nav.tsx`; `src/shared/rate-limit/index.ts`; `src/shared/storage/{r2-client.ts,upload.ts}`; `src/app/api/upload/presign/route.ts`; `src/shared/db/{client.ts,errors.ts}`; `src/env.ts`; `.env.example`; `prisma/schema.prisma`.

---

## Background Jobs & Email

The app uses **Inngest** for all background/durable-workflow processing (`src/jobs/`, wired through a single `src/shared/inngest/client.ts` proxy and served from `src/app/api/inngest/route.ts`) and **Resend** with **React Email** for all transactional email (`src/emails/`, dispatched through `src/modules/notifications/notifications.email.ts`).

### Inngest client (`src/shared/inngest/client.ts`)

A single shared `Inngest` client (id `nexlet`) is wrapped in a `Proxy`. In normal operation `inngest.send()`/`sendBatch()` pass straight through to the real Inngest SDK (fire-and-forget event emission to Inngest Cloud/dev server). When `E2E_TEST_MODE=true`, the proxy intercepts `send`/`sendBatch` and routes them synchronously through a test adapter (`src/shared/adapters/registry.ts`) instead, so E2E tests can execute job logic in-process without a running Inngest server. `getAdapter()` hard-refuses to run if `NODE_ENV=production`, preventing test adapters from ever activating in prod.

### Job inventory

**20 files in `src/jobs/`** export **43 distinct Inngest functions** (many files define multiple related handlers, e.g. `trust-safety-notifications.job.ts` alone exports 7). All 43 are individually registered in the `functions: [...]` array of `src/app/api/inngest/route.ts` — nothing is defined but left unregistered (with one indirect exception noted under Incomplete/stubs: two events, `team/invite-sent` / `team/invite-accepted`, are emitted but have **no handler at all**).

Below, jobs are grouped by the workflow they belong to.

#### 1. Booking lifecycle state machine

**`booking-hold-timeout.job.ts` — `bookingHoldTimeout`** (event: `booking/approved`)
Starts a durable timer (`step.waitForEvent`) for `holdDurationHours` (event payload, default 48h) waiting for `booking/paid`. If payment arrives, exits early. If it times out, it re-checks the booking is still `APPROVED` and that no `Contract` is `SENT`/`PARTIALLY_SIGNED` for it (if one is, it defers — `contractSigningFlow` owns that booking's expiry via its own 7-day timeout) — only then calls `bookingsService.expireBooking()` to release the held calendar dates.

**`booking-request-timeout.job.ts` — `bookingRequestTimeout`** (event: `booking/requested`)
Waits up to 72h for `booking/approved`; if the owner never acts, re-verifies status is still `REQUESTED` (guards against races) and auto-expires the request so it doesn't block the calendar indefinitely.

**`booking-completion.job.ts` — `bookingCompletionScheduler`** (cron `0 2 * * *`, daily 2 AM UTC — chosen because most villa markets are past local midnight checkout by then)
Finds all `CONFIRMED` bookings whose `checkOut` is on/before today and transitions each to `COMPLETED` via `bookingsService.transitionState`, one at a time inside a single step (per-booking try/catch so one failure doesn't block others). This is the trigger for the entire post-stay chain (deposit hold → claim window → rating prompts).

**`booking-notifications.job.ts`** — six thin "fetch booking → notify" handlers, each in-app + (where applicable) email:
- `onBookingRequested` (`booking/requested`) → notifies owner, email `BOOKING_REQUESTED`
- `onBookingApproved` (`booking/approved`) → notifies agent, email `BOOKING_APPROVED`
- `onBookingCancelled` (`booking/cancelled`) → figures out which party cancelled (`cancelledBy === agentId`) and notifies the *other* party, email `BOOKING_CANCELLED`
- `onBookingExpired` (`booking/expired`) → notifies **both** agent and owner, both get email `BOOKING_EXPIRED`
- `onBookingPaid` (`booking/paid`) → in-app only, notifies owner (no email — receipt email is handled separately by `onPaymentReceived`)
- `onBookingConfirmed` (`booking/confirmed`) → in-app only, notifies both agent and owner (no email template wired for `BOOKING_CONFIRMED` despite one existing — see Incomplete/stubs)

**Fan-out note:** `booking/approved` alone triggers 4 separate durable functions concurrently: `onBookingApproved` (notify), `bookingHoldTimeout`, `contractSigningFlow`, and `contractReminders`. `booking/confirmed` triggers 5: `onBookingConfirmed`, `payoutProcessingFlow`, `preStayPhotoReminder`, `insuranceActivationFlow`, `onBookingConfirmedCheckSelections`.

#### 2. Contract signing (DocuSign — real integration, not a stub)

**`contract-signing-flow.job.ts` — `contractSigningFlow`** (event: `booking/approved`)
Calls `contractsService.generateAndSendForSigning(bookingId)` (real DocuSign JWT server-to-server integration in `src/modules/contracts/docusign.adapter.ts`, with anchor-string signature tab placement and 50-min token caching), then durably waits up to 7 days for `contract/all-signed`. On success, transitions booking to `CONTRACTED`. On timeout, marks the `Contract` `EXPIRED` and calls `bookingsService.expireBooking()`.

**`contract-reminders.job.ts` — `contractReminders`** (event: `booking/approved`, runs in parallel with the flow above)
Sends escalating in-app reminders to whichever of agent/owner hasn't signed (client signs via DocuSign email directly, not notified in-app): 24h reminder, 48h reminder, then up to 5 more daily reminders (covering the full 7-day window), checking `contract/all-signed` between each wait and bailing out immediately if signed.

**`payment-notifications.job.ts`** — contract-related handlers:
- `onContractReady` (`contract/sent`) → notifies **both** agent and owner with role-specific `actionUrl`s, email `CONTRACT_READY`
- `onContractSignedParty` (`contract/signer-completed`) → notifies whichever of agent/owner *didn't* just sign (in-app only)
- `onContractAllSigned` (`contract/all-signed`) → notifies both agent and owner (in-app only — despite a `CONTRACT_ALL_SIGNED` email template existing and being wired in `notifications.email.ts`, this handler never calls it, see Incomplete/stubs)

#### 3. Payments, balances, payouts

**`payment-notifications.job.ts`** — `onPaymentReceived` (`booking/paid`) notifies agent + owner with email `PAYMENT_RECEIVED` (renders `PaymentReceiptEmail`); `onPaymentFailed` (`payment/failed`) notifies agent in-app only; `onPayoutCompleted` (`payout/completed`) notifies owner with email `PAYOUT_COMPLETED`.

**`payout-processing.job.ts` — `payoutProcessingFlow`** (event: `booking/confirmed`)
Real Stripe Connect integration (`stripe-connect.adapter.ts`, Separate-Charges-and-Transfers model, not destination charges). Loads the booking's `financialBreakdown` JSON, looks up owner/agent Stripe Connect account IDs, verifies each account's `payoutsEnabled`/`chargesEnabled` via `getAccountStatus`, and — **critically — only transfers the *balance* portion to the owner at this stage** (deposit is deliberately withheld as damage protection until after checkout/COMPLETED). Owner's balance share is computed as `ownerNetPayoutCents * (balanceCents / clientTotalCents)`, floored. Agent gets their full `agentTotalEarningsCents` commission transferred immediately. Either leg is skipped gracefully (funds "held in platform balance until manual intervention") if the destination account isn't fully onboarded/verified — no retry loop or reconciliation job exists for these skipped transfers (see Incomplete/stubs). On success, creates a `Payout` DB record and emits `payout/completed` to trigger the owner notification (kept as a separate event specifically to avoid duplicate notifications).

**`balance-collection.job.ts`** — two functions:
- `balanceCollectionScheduler` (cron `0 9 * * *`, daily 9 AM UTC): finds `BALANCE` payments due within 30 days with `remindersSent === 0` and calls `paymentsService.sendPaymentLink()` for each (marking `remindersSent: 1`). Separately, finds overdue balances (`dueDate < now`, `remindersSent === 1`) and emits `payment/balance-due` to kick off the grace-period flow, bumping `remindersSent: 2` to prevent re-triggering.
- `balanceGracePeriodFlow` (event: `payment/balance-due`): a 4-stage escalation using `step.waitForEvent`/timeout pairs — Day 1 reminder → wait 2d for `payment/balance-paid` → Day 3 urgent reminder → wait 2d → Day 5 final warning → wait 1d → **Day 6 auto-cancel**. Auto-cancel re-verifies payment is still `PENDING`, calls `bookingsService.cancelBooking(bookingId, "system", ...)`, notifies both parties, and — if a `SUCCEEDED` deposit payment exists — calls `paymentsService.processRefund()` to refund it. All reminders here are **in-app only**, despite a `BalanceDueReminderEmail` template existing that supports exactly this urgency/overdue styling (unused — see Incomplete/stubs).

**`subscription-sync.job.ts` — `subscriptionSync`** (event: `stripe/subscription-event`, emitted from the Stripe webhook handler)
Syncs local subscription status via `billingService.syncSubscriptionStatus()` for `created`/`updated`/`deleted` Stripe subscription events, and sends type-specific in-app notifications: welcome/trial-started, past-due payment warning, trial-ending-in-≤3-days warning (computed inline from `trialEnd`), and cancellation notice. In-app only — no emails, despite Pro-subscription events being naturally high-value candidates for email.

#### 4. Trust & safety — damage claims, security deposits

**`deposit-release.job.ts` — `depositReleaseFlow`** (event: `booking/completed`)
Puts the deposit into `HELD` via `depositsService.holdDeposit()` (gracefully returns "skipped" if the property had no default deposit configured), then durably waits 7 days for `claim/filed`. If a claim comes in, calls `holdForClaim()` and stops (claim flow owns resolution from here). If the window passes clean, calls `releaseDeposit()` (full Stripe refund) and emits `reputation/prompt-rating`.

**`claim-review-timeout.job.ts` — `claimReviewTimeout`** (event: `claim/filed`)
Gives the agent 72h (`step.waitForEvent` on `claim/agent-reviewed`) to respond. If they don't, calls `claimsService.autoEscalateExpiredReview(claimId)`.

**`trust-safety-notifications.job.ts`** — 7 handlers, all **in-app only** by explicit design comment ("Email templates for Phase 4 notification types will be created alongside the UI pages"):
`onClaimFiled` (72h review-deadline note), `onClaimAgreed` (filters for `response === "AGREED"`), `onClaimDisputed` (filters for `"DISPUTED"`), `onClaimResolved` (both parties, states the deduction amount), `onClaimEscalated` (both parties, distinguishes "agent timed out" vs. "agent disputed" wording), `onDepositReleased` (`deposit/released` — notifies agent + owner that the 7-day window closed clean), `onDepositCharged` (`deposit/charged` — notifies agent of the charged amount).

**`insurance-activation.job.ts` — `insuranceActivationFlow`** (event: `booking/confirmed`)
Fetches booking + property, calls `insuranceProvider.createPolicy()`, persists an `InsurancePolicy` record via `insuranceService.activatePolicy()`, then generates and uploads a real certificate PDF (`insuranceService.generateCertificatePdf`, `@react-pdf/renderer` → R2 upload → DB update — this part is fully implemented despite a stale in-file comment claiming it's "a placeholder"). **The insurance itself is fake**: `src/modules/insurance/insurance.adapter.ts`'s `StubInsuranceProvider` fabricates a policy with a canned premium formula (`guestCount * nights * 500` cents) and hardcoded coverage (EUR 50K property damage / EUR 1M liability, cancellation always "included") — explicitly documented as a placeholder for a future Tint SmartSTR partnership. No real underwriter is on the other end; every booking gets synthetic "insurance."

**`pre-stay-photo-reminder.job.ts` — `preStayPhotoReminder`** (event: `booking/confirmed`)
Uses `step.sleepUntil` (not `waitForEvent`) to sleep until exactly 24h before check-in (or fires immediately if check-in is already <24h away), checks `booking.preStayPhotosUploaded`, sends an in-app reminder if not uploaded, sleeps again until 6h before check-in, and sends a second, more urgent reminder if still not uploaded. In-app only by design comment; no auto-escalation or hard requirement enforced if the owner never uploads — the flow just ends.

**`rating-prompt.job.ts` — `ratingPromptFlow`** (event: `reputation/prompt-rating`, sent only from the clean-deposit-release path)
Sends reciprocal rating prompts: owner is asked to rate the agent, agent is asked to rate the owner. In-app only. **Note:** this only fires when the deposit released cleanly (no claim) — bookings that go through the claim path never get a rating prompt from this flow.

#### 5. Messaging

**`message-notifications.job.ts` — `onMessageSent`** (event: `message/sent`)
Looks up sender/recipient names and the booking's property, determines the recipient's role to build the correct `/agent/` vs `/owner/` messages link, and sends both an in-app notification and email `NEW_MESSAGE` with a message preview.

#### 6. Villa selections (agent-curated client proposals)

**`selection-availability.job.ts`** — 3 functions:
- `onSelectionVillaAdded` (`selection/villa-added-pending`): notifies owner in-app + email (`SELECTION_VILLA_CONFIRM`, renders `AvailabilityConfirmEmail`) that an agent wants to include their villa in a client selection.
- `selectionConfirmationReminders` (cron `0 9 * * *`): finds `PENDING` `SelectionVilla` rows older than 24h with `remindersSent < 2`, sends numbered reminders ("1/2", "2/2") and bumps the counter; separately finds rows with `remindersSent >= 2` still pending and notifies the *agent* that the owner is unresponsive (suggesting they remove the villa) — this doesn't auto-remove anything, just flags it.
- `onBookingConfirmedCheckSelections` (`booking/confirmed`): when any booking is confirmed, finds all `PENDING`/`CONFIRMED` `SelectionVilla` rows for that same property with an overlapping date range (`selection.checkIn < booking.checkOut AND selection.checkOut > booking.checkIn`) and force-marks them `UNAVAILABLE`, notifying the affected agent(s). This is the mechanism that prevents a villa from staying "available" in a client-facing selection after someone else has actually booked it.

**`selection-notifications.job.ts`** — 4 lightweight agent-facing handlers, all in-app-only except one: `onSelectionVillaFavorited` (`selection/villa-favorited`, explicitly no-ops on unfavorite events), `onSelectionBookingRequested` (`selection/booking-requested`, in-app **and** email `SELECTION_BOOKING_REQUESTED`), `onSelectionViewed` (`selection/viewed`, low-priority/in-app-only by design), `onSelectionVillaConfirmed` (`selection/villa-confirmed`, in-app only).

**`selection-pdf-generation.job.ts` — `generateSelectionPdf`** (event: `selection/pdf-requested`, the only job with an explicit `retries: 2` override)
The most compute-heavy job in the codebase: fetches the `CONFIRMED` villas on a selection with photos/amenities/seasons and the agent's white-label branding (`AgentBrand`), pre-fetches every hero photo + logo to a Buffer with a 10s timeout (falls back to a 1×1 transparent PNG placeholder on any fetch failure — deliberate `@react-pdf/renderer` CORS/timeout workaround), computes live per-villa pricing from current seasonal rate tables (duplicating `computeTotalStayPrice` logic that also exists in `selectionsService`, per an explicit in-code decision reference), renders the PDF via `renderSelectionPdf`, uploads it to R2, and writes `pdfR2Key`/`pdfUrl` back onto the `Selection` row.

#### 7. Calendar sync

**`ical-sync.job.ts` — `syncICalFeeds`** (cron `*/15 * * * *`, every 15 minutes)
Pulls every active `CalendarFeed`/iCal import feed and re-syncs each **inside its own `step.run`**, deliberately isolating failures per-feed (one broken feed URL doesn't block others). Delegates the actual ICS parsing/import/conflict-detection to `icalImportService.syncFeed()`; returns per-feed `imported`/`conflicts`/`error` counts. Outbound/export iCal feed generation was not found under `src/jobs` — this job is import-only.

### Email templates (Resend + React Email)

All email dispatch funnels through `src/modules/notifications/notifications.email.ts`, a single discriminated-union `EmailTemplate` type mapped via `getTemplateContent()`/`getSubjectForTemplate()` to a `react-email` component, sent with `getResend().emails.send()` from `NexLet <notifications@nexlet.com>`. Failures are caught and logged, never thrown (`sendNotificationEmail` always resolves `{success:false}` rather than blocking the in-app notification path). In `E2E_TEST_MODE`, sending is intercepted by a test adapter instead of hitting Resend. Every send additionally respects a per-user, per-event-type `NotificationPreference.emailEnabled` toggle (checked in `notificationsService.sendEmail`/`.notify`) before Resend is ever called.

Of **19 template files** in `src/emails/`, **14 are actually wired into `EmailTemplate`/`getTemplateContent()`** and reachable from a live code path:

| Template | Trigger (event → job) | Notes |
|---|---|---|
| `BookingRequestedEmail` | `booking/requested` → `onBookingRequested` | to owner |
| `BookingApprovedEmail` | `booking/approved` → `onBookingApproved` | to agent |
| `BookingExpiredEmail` | `booking/expired` → `onBookingExpired` | to agent **and** owner |
| `BookingCancelledEmail` | `booking/cancelled` → `onBookingCancelled` | to whichever party didn't cancel |
| `NewMessageEmail` | `message/sent` → `onMessageSent` | includes message preview |
| `ContractReadyEmail` | `contract/sent` → `onContractReady` | to agent **and** owner, role-aware CTA copy |
| `PaymentReceiptEmail` (type `PAYMENT_RECEIVED`) | `booking/paid` → `onPaymentReceived` | to agent **and** owner |
| `BalanceDueReminderEmail` (type `BALANCE_DUE_REMINDER`) | **defined/mapped but never called** | see below — dead despite being "wired" |
| `PayoutCompletedEmail` | `payout/completed` → `onPayoutCompleted` | to owner |
| `AvailabilityConfirmEmail` (type `SELECTION_VILLA_CONFIRM`) | `selection/villa-added-pending` → `onSelectionVillaAdded` | to owner |
| `SelectionBookingRequestedEmail` | `selection/booking-requested` → `onSelectionBookingRequested` | to agent |
| `SelectionLinkEmail` | called directly (not via a job) from `src/modules/selections/selections.actions.ts:374` | sent to the **client** (external, no platform account) when an agent shares a selection link; supports agent-brand accent color and truncated cover-note preview |
| `BookingConfirmedEmail`, `ContractAllSignedEmail`, `PaymentLinkEmail`, `BookingHoldWarningEmail`, `SubAgentInviteEmail` | mapped in the switch, but **no caller anywhere passes these template types** | fully built, entirely unreachable — see Incomplete/stubs |

### Incomplete/stubs

- **`team/invite-sent` and `team/invite-accepted` events have no Inngest handler at all.** `teams.service.ts` (`inviteSubAgent`, `acceptInvite`) emits both events, but no file in `src/jobs/` subscribes to them and neither is registered in `route.ts`. The fully-built `SubAgentInviteEmail` template (and its `SUB_AGENT_INVITE` case in `notifications.email.ts`) is consequently **dead code** — an invited sub-agent never receives an invitation email; they'd only find out via a shared link communicated outside the platform. `SUB_AGENT_JOINED` (used for the accepted side) has a `NOTIFICATION_TYPE_LABELS` entry and default preferences but also no email template or job handler.
- **`PaymentLinkEmail` (`PAYMENT_LINK_SENT`) is fully built and wired into the switch, but `paymentsService.sendPaymentLink()` — its only intended caller — never calls `sendNotificationEmail`.** It only creates an in-app notification for the *agent* ("Payment link sent to client"); the client, who has no platform account, never actually receives the payment-link email the docstring promises ("Generates a checkout URL and sends an email"). This affects both the balance-collection cron and the manual "send payment link" agent action.
- **`BookingHoldWarningEmail` (`BOOKING_HOLD_WARNING`) is fully built, has default preferences, and a UI toggle in `notification-preferences.tsx`, but is never triggered by any job.** `bookingHoldTimeout` goes straight from waiting to expiring with no intermediate "your hold expires in N hours" warning step — despite the template existing specifically for that purpose.
- **`BookingConfirmedEmail` (`BOOKING_CONFIRMED`) is fully built and mapped, but `onBookingConfirmed` (the matching job) only creates in-app notifications** for agent and owner — no `sendEmail`/`notify` call with this template anywhere.
- **`ContractAllSignedEmail` (`CONTRACT_ALL_SIGNED`) is fully built and mapped, but `onContractAllSigned` never sends it** — in-app only, same pattern.
- **`BalanceDueReminderEmail` (`BALANCE_DUE_REMINDER`) is fully built, mapped, and has overdue-styled variants (client vs. agent copy, grace-period warning box) — but `balanceGracePeriodFlow`'s day-1/3/5 reminders and the auto-cancellation only call `notificationsService.create` (in-app), never `.sendEmail`.** This is arguably the highest-impact gap: the one flow that auto-cancels a booking and refunds a deposit never emails anyone about it, despite `BALANCE_DUE_REMINDER` defaulting to `emailEnabled: true` in `DEFAULT_PREFERENCES`.
- **`availability-request.tsx` and `selection-updated.tsx` are orphan components** — not imported by `notifications.email.ts` at all, not part of the `EmailTemplate` union, no `NotificationType` case sends them. `selection-updated.tsx` even has a matching `SELECTION_UPDATED` entry in `NOTIFICATION_TYPE_LABELS`/`DEFAULT_PREFERENCES` (`emailEnabled: true`), reinforcing that it was planned but never connected to any sender. `availability-request.tsx` appears to be an earlier/duplicate draft of `AvailabilityConfirmEmail` (nearly identical content, different prop shape) that was superseded but never deleted.
- **Every claim/deposit event type (`CLAIM_FILED`, `CLAIM_AGREED`, `CLAIM_DISPUTED`, `CLAIM_RESOLVED`, `CLAIM_ESCALATED`, `DEPOSIT_RELEASED`, `DEPOSIT_CHARGED`), `RATING_REQUESTED`, `PRE_STAY_PHOTOS_REMINDER`, `PAYMENT_FAILED`, `BALANCE_OVERDUE`, `BALANCE_AUTO_CANCELLED`, `CONTRACT_REMINDER`, and all three `SUBSCRIPTION_*` types default to `emailEnabled: true` in `notifications.types.ts`, yet have no `EmailTemplate` case and no template file at all.** The corresponding jobs (`trust-safety-notifications.job.ts`, `rating-prompt.job.ts`, `pre-stay-photo-reminder.job.ts`, `contract-reminders.job.ts`, `subscription-sync.job.ts`, parts of `payment-notifications.job.ts` and `balance-collection.job.ts`) all explicitly document this as in-app-only "for now" — this is a broad, consistently-documented gap rather than an oversight in any single file, but it means a user who enables email notifications for e.g. "Damage Claim Filed" in Settings will never actually get one.
- **Insurance is entirely synthetic.** `insurance-activation.job.ts` runs a real, fully-wired pipeline (DB writes, certificate PDF generation, R2 upload), but the policy data itself comes from `StubInsuranceProvider`, which fabricates premiums/coverage with no real underwriter — explicitly commented as a placeholder pending a Tint SmartSTR partnership.
- **Stripe Connect payout failures have no retry/reconciliation mechanism.** `payoutProcessingFlow` gracefully no-ops when an owner or agent hasn't completed Stripe onboarding ("funds held in platform balance until manual intervention" / "commission deferred"), but there is no scheduled job anywhere in `src/jobs/` that re-attempts these deferred transfers once the account later becomes ready — it's a one-shot check tied only to the `booking/confirmed` event.
- **`selectionConfirmationReminders`'s "notify agent that owner is unresponsive" branch is purely informational** — it does not auto-remove the villa from the selection or stop further reminders; an owner who never responds stays `PENDING` indefinitely with no further automated escalation past the two reminders.

---

## API Routes

The API surface is split into two generations: a small set of legacy/public routes directly under `src/app/api/*` (cookie-auth only, or fully public/token-based), and the bulk of the surface under `src/app/api/v1/*`, which is the "real" REST API consumed by both the web app and the Expo mobile app. Nearly all `v1` routes go through a shared factory, `createApiHandler` (`src/shared/utils/create-api-handler.ts`), which wraps every handler with: (1) dual-mode auth via `getApiAuthContext` — Supabase cookie session first, falling back to a `Bearer <token>` header for mobile (`src/shared/auth/guards.ts`), (2) optional role gating (`UserRole.OWNER | AGENT | ADMIN`, where ADMIN always passes any role check), (3) Zod schema validation of the JSON body (or query string for GET), and (4) a standard `{ success, data }` / `{ success:false, error, code }` envelope with error-to-HTTP-status mapping (Zod → 400, `"Unauthorized"` → 401, `"User profile not found"` → 401, any other thrown `Error` → 400, unknown → 500).

93 `route.ts` files were read in full for this audit.

### Auth (`/api/auth/*`, `/api/v1/auth/*`)
- `GET /api/auth/me` — cookie-only (no Bearer fallback), returns `{firstName, role, email}` for the signed-in user. Legacy/web-only; superseded by the v1 route below.
- `POST /api/auth/sign-out` — cookie-only, signs out via Supabase and redirects to a caller-supplied `redirect` query param, restricted to same-origin relative paths (open-redirect guard: rejects `//`-prefixed values).
- `GET /api/v1/auth/me` — dual auth (cookie+Bearer). Returns `data: null` (not a 401) if the Supabase user exists but has no `UserProfile` yet, so the mobile app can distinguish "not logged in" from "logged in, needs onboarding."
- `POST /api/v1/auth/profile` — dual auth, no existing-profile requirement. Upserts a `UserProfile` with a chosen `role` (`OWNER|AGENT|ADMIN`) during onboarding; update is a no-op if the profile already exists (so it can't silently change role).
- `PATCH /api/v1/auth/profile` — dual auth. Lets an already-registered user switch role by passing `{role}`. **No restriction on which role is settable** — see Incomplete/Stubs.

### Bookings (`/api/v1/bookings/*`)
- `GET /api/v1/bookings` — any authenticated role; OWNER sees bookings across their properties, AGENT sees only bookings they created (`bookingsService.getOwnerBookings` / `getAgentBookings`), optional `?status=` filter.
- `POST /api/v1/bookings` — AGENT only. Creates a booking: verifies the target `Property.status === "PUBLISHED"`, computes nightly pricing from `Season` records via `Decimal.js` (falls back to the cheapest season's rate for any night not covered by a season), applies non-optional `ExtraFee`s (flat or per-night), and computes agent markup (flat cents, or percentage where `value` is stored as `pct*100`, e.g. 1000 = 10%). Booking mode determines initial status: `Property.bookingMode === "INSTANT"` → `APPROVED` immediately (with a hold expiry = `now + holdDurationHours`), otherwise → `REQUESTED`. For instant bookings, enforces `maxHoldsPerAgent` (rejects if the agent already has that many active holds on the property). Resolves the agent's `Agency`/sub-agent membership to tag `agencyId`. Emits `booking/approved` or `booking/requested` to Inngest.
- `GET /api/v1/bookings/[id]` — any auth; service enforces caller must be the booking's agent, the property's owner, or admin.
- `POST /api/v1/bookings/[id]/approve` — OWNER only, and service re-verifies caller is the specific property's owner. Transitions `REQUESTED → APPROVED`, re-checks `maxHoldsPerAgent`, sets a fresh hold expiry, and — if the property has a `defaultSecurityDepositCents > 0` — auto-creates a `SecurityDeposit` record.
- `POST /api/v1/bookings/[id]/decline` — OWNER only, requires a non-empty `cancellationReason`. `REQUESTED → CANCELLED`, releases blocked `CalendarDay`s.
- `POST /api/v1/bookings/[id]/cancel` — any auth; service allows either the booking's agent or the property owner. Only allowed while status is `REQUESTED | APPROVED | CONTRACTED` (blocked once `PAID`+). If cancelling a `CONTRACTED` booking, voids the DocuSign envelope first so signers don't get a stale link.
- Full state machine (`VALID_TRANSITIONS` in `bookings.types.ts`): `REQUESTED→{APPROVED,CANCELLED,EXPIRED}`, `APPROVED→{CONTRACTED,CANCELLED,EXPIRED}`, `CONTRACTED→{PAID,CANCELLED,EXPIRED,APPROVED}`, `PAID→{CONFIRMED}`, `CONFIRMED→{COMPLETED,CANCELLED}`, terminal: `COMPLETED, CANCELLED, EXPIRED`.

### Listings (`/api/v1/listings/*`)
- `GET /api/v1/listings` — OWNER only, returns the caller's own listings.
- `POST /api/v1/listings` — OWNER only (ADMIN may pass `onBehalfOfOwnerId` to create on behalf of another owner, tagging `createdByAdminId`). New listings always start `status: DRAFT`.
- `GET /api/v1/listings/[id]` — **any authenticated user, no ownership/role check** — returns the full listing regardless of status (DRAFT/PENDING_REVIEW/etc.) or who owns it (see Incomplete/Stubs).
- `PUT /api/v1/listings/[id]` — any auth, but `listingsService.update` calls an internal `verifyAccess` (owner or admin only). If the listing was `CHANGES_REQUESTED`, any update resets it to `DRAFT`.
- `PUT /api/v1/listings/[id]/amenities` — OWNER, overwrites the amenity set.
- `POST/DELETE /api/v1/listings/[id]/fees` — OWNER, add/remove `ExtraFee` (flat or per-night, optional).
- `POST/PUT/DELETE /api/v1/listings/[id]/photos` — OWNER: register a photo (client already uploaded to R2 via the presign flow), `PUT` handles both hero-photo selection (`action:"setHero"`) and drag-reorder (`photoIds[]`), `DELETE` removes one.
- `POST/DELETE /api/v1/listings/[id]/seasons` — OWNER, add/remove a pricing `Season`; overlapping date ranges are rejected with the conflicting season named in the error.
- `POST/DELETE /api/v1/listings/[id]/staff` — OWNER, manage on-site staff/services line items.
- `POST /api/v1/listings/[id]/submit` — OWNER, moves `DRAFT|CHANGES_REQUESTED → PENDING_REVIEW`. Enforces minimum-completeness gate before allowing submission: ≥1 photo, `descOverview` ≥50 chars, `descBedrooms/descBathrooms/descOutdoorSpaces/descLocation` each ≥20 chars, ≥1 season defined. All violations are collected and returned together, not just the first.
- Admin-side lifecycle (`/api/v1/admin/properties/*`, ADMIN only): `approve` (`PENDING_REVIEW→APPROVED`), `publish` (`APPROVED→PUBLISHED`), `reject` (`PENDING_REVIEW→CHANGES_REQUESTED`, requires a non-empty review note). Full listing lifecycle: `DRAFT → PENDING_REVIEW → APPROVED → PUBLISHED`, with `CHANGES_REQUESTED` as a rejection loop back to `DRAFT`.

### Calendar & iCal (`/api/v1/calendar/*`, `/api/ical/[propertyId]`)
- `GET /api/v1/calendar/[propertyId]?month=&year=` — any auth (no ownership check needed — used by agents browsing availability), returns sparse `CalendarDay` records for that month.
- `POST /api/v1/calendar/[propertyId]/block` / `unblock` — OWNER only, verified against `Property.ownerId`. Toggling logic refuses to touch dates that are `BOOKED` or `ICAL_BLOCKED` (must remove the external feed block first).
- `GET/POST /api/v1/calendar/[propertyId]/ical` — OWNER only. `GET` lists configured `iCalFeed`s for the property; `POST` adds a new feed URL, validated against SSRF (`isAllowedICalUrl` — only public HTTP(S) allowed, presumably blocking private/link-local ranges). **No DELETE route** exists even though `icalImportService.removeFeed` and a conflict-resolution function exist in the service layer — unreachable via the API (see Incomplete/Stubs).
- `GET /api/ical/[propertyId]` — fully public, no auth. Validates the property ID is a UUID and exists, then streams a generated `.ics` file (`Content-Type: text/calendar`, `Cache-Control: max-age=300`) for external platforms (Airbnb/VRBO/Booking.com) to subscribe to. Rate-limited 30/min per IP.

### Payments & Checkout (`/api/v1/payments/*`, `/api/checkout/*`)
Two parallel implementations exist for the same "pay a booking" flow:
- **Legacy/web** — `/api/checkout/[bookingId]` (GET), `/api/checkout/[bookingId]/create-intent` (POST), `/api/checkout/[bookingId]/create-deposit-intent` (POST). All fully public (no auth), gated instead by a `checkoutToken` stored on the `Payment` row, matched to the `bookingId` in the URL, with expiry (`checkoutExpiresAt`) and status checks (`already_paid`, `refunded`, `not_available` if booking isn't `CONTRACTED`/`APPROVED`). GET returns a client-safe financial breakdown (blended nightly rates, no owner base price/markup/commission split). Rate-limited 30/min per IP. Validates `bookingId` as a UUID via regex.
- **v1/mobile** — `GET/POST /api/v1/payments` (list payments for the caller by role: owner sees payout history, agent sees payment tracking; POST creates a `Payment` record for a booking), `GET /api/v1/payments/checkout` (auth disabled, same token-validated checkout-data lookup, reimplemented separately in `paymentsService.getCheckoutData`), `POST /api/v1/payments/intent` (creates the `Payment` + Stripe `PaymentIntent` together and returns `clientSecret` for Stripe's mobile PaymentSheet SDK — the doc comment explicitly notes this differs from `/checkout` which is redirect-based), `GET /api/v1/payments/[bookingId]` (lists all payments for a booking).
- **No caller-identity/ownership check anywhere in this v1 payments path**: `POST /api/v1/payments` and `POST /api/v1/payments/intent` accept any authenticated user's request to create a payment against any `bookingId`; `GET /api/v1/payments/[bookingId]` returns any booking's payment rows to any authenticated user (see Incomplete/Stubs — cross-cutting).
- `/api/v1/deposits/[bookingId]` (GET/POST) — creates/reads `SecurityDeposit` records; same gap, no ownership check on POST.
- `/api/v1/connect/*` (OWNER-only, dual auth): `POST onboard` creates/refreshes a Stripe Express connected account and returns an onboarding link; `GET status` reports `chargesEnabled/payoutsEnabled/detailsSubmitted`; `POST dashboard` returns an Express dashboard login link. All explicitly built for "mobile app opens this URL in expo-web-browser."

### Deposits — Security Deposits (`/api/v1/deposits/[bookingId]`)
Covered above under Payments. State machine enforced service-side (not visible at route level): `PENDING → charged → HELD → CLAIM_HOLD (if a claim is filed) → released/deducted`. `chargeDeposit`/`markCharged` require `PENDING` status; deduction cannot exceed the deposit amount.

### Contracts / DocuSign (`/api/v1/contracts/[bookingId]/*`)
- `GET /api/v1/contracts/[bookingId]` — generates a draft contract PDF (`contractsService.generateContract`).
- `POST /api/v1/contracts/[bookingId]` — generates and immediately sends the contract to DocuSign for signing.
- `GET .../download?type=draft|signed` — returns a 1-hour presigned R2 URL for the PDF.
- `GET .../sign?contractId=&signerRole=agent|owner&returnUrl=` — returns an embedded DocuSign signing URL for the given party.
- `POST .../void` — voids the DocuSign envelope (only meaningful from `SENT`/`PARTIALLY_SIGNED` status; no-ops silently otherwise).
- **None of these five routes have any auth-role restriction or ownership check**, at either the route or service layer — any authenticated user who knows/guesses a `bookingId` (or `contractId`) can generate a contract for someone else's booking, fetch its signed PDF via a presigned URL, obtain an embedded signing URL impersonating either the agent or owner role, or void it (see Incomplete/Stubs).

### Claims / Trust & Safety (`/api/v1/claims/*`)
- `POST /api/v1/claims` — OWNER only. `claimsService.fileClaim` requires: booking `status === "COMPLETED"`, caller is the property owner, no existing claim already filed for the booking, deposit exists and is `HELD`/eligible, and **must be filed within 24 hours of checkout** (hard deadline). Sets deposit to `CLAIM_HOLD` and claim to `FILED`.
- `POST /api/v1/claims/[id]/review` — AGENT only. Agent responds `AGREED` or `DISPUTED` (dispute requires a reason ≥20 chars). Only valid while claim is `UNDER_REVIEW`, and only the booking's agent may respond.
- `POST /api/v1/claims/[id]/resolve` — ADMIN only. Sets a `deductionAmountCents` (≥0) to close out the claim; validated against a `ClaimStatus` transition table.
- Service also has an unexposed `autoEscalateExpiredReview` (review-deadline auto-escalation, presumably Inngest-driven, not a client-facing route) and `closeClaim`.

### Reputation (`/api/v1/reputation/*`)
- `POST /api/v1/reputation` — OWNER|AGENT. Binary thumbs-up/down rating (`rating: boolean`) plus optional `respondedOnTime`/`resolvedWithoutEscalation` flags. Requires booking `status === "COMPLETED"`, caller must be the actual owner/agent on that booking (role-matched), and `rateeId` must be exactly the other party — can't rate a third party.
- `POST /api/v1/reputation/guest` — any auth, flags a guest by email against a completed booking with a typed reason (`party|damage|rule_violation|noise|excessive_cleaning|family|business|corporate|other`).
- `GET /api/v1/reputation/guest?guestEmail=` and `GET /api/v1/reputation/user?userId=&role=` — any auth, no ownership restriction (by design — this is a cross-party trust lookup, not sensitive per-user data).

### Admin (`/api/v1/admin/*`)
All ADMIN-only. `GET agents?status=` (agent application queue, filterable), `GET counts` (platform summary — pending counts etc.), `GET owners` (owner list for the "create listing on behalf of" flow), `GET properties` (pending-review queue), `POST properties/[id]/approve|publish|reject` (see Listings above for the state machine and gating).

### Agent Applications (`/api/v1/agents/*`)
- `GET /api/v1/agents` — ADMIN only, all applications.
- `GET/POST /api/v1/agents/application` — any auth: GET returns the caller's own application (or null), POST submits a new one (rejects duplicates — one application per user).
- `POST /api/v1/agents/[id]/approve` — ADMIN, optional review note.
- `POST /api/v1/agents/[id]/reject` — ADMIN, requires `rejectionReason`.
- `POST /api/v1/agents/[id]/revoke` — ADMIN, sets status `REVOKED`.

### Teams / Agencies (`/api/v1/teams/*`)
AGENT-only throughout. `GET /` lists the caller's team (lazily resolves/creates their `Agency` on first use) with a commission summary. `POST /invite` invites a sub-agent by email — upserts an `AgencyInvite`, rejects if a pending invite to that email already exists. `POST /[id]/deactivate` removes a sub-agent from the team; optionally reassigns their open bookings to another team member or `"self"` (the main agent).

### Billing / Subscriptions (`/api/v1/billing/*`)
AGENT-only. `GET /` returns subscription info, defaulting to `{tier: FREE, status: ACTIVE}` if no `AgentSubscription` row exists yet. `POST /upgrade` starts a 30-day-trial Pro subscription via Stripe (rejects if already `PRO` and not `CANCELLED`); requires a configured Stripe price ID per billing interval (monthly/annual) or throws. `GET /portal?returnUrl=` returns a Stripe Customer Portal link (requires an existing `stripeCustomerId`, i.e. must have upgraded at least once).

### Messaging (`/api/v1/messaging/*`, `/api/messages/stream/[threadId]`)
Any authenticated user, but access is enforced inside `messagingService` for every operation (caller must be the booking's agent or the property's owner): `GET /` inbox, `POST /` create a thread (agent-only in practice — service checks caller is the booking's agent), `GET /[threadId]`, `POST /[threadId]/messages` (content 1–5000 chars; service also caps attachments at a `MAX_ATTACHMENTS` constant), `POST /[threadId]/read` marks read. `GET /api/messages/stream/[threadId]` is a Server-Sent-Events long-poll endpoint (5s poll interval, `Last-Event-ID` header resume support), dual-auth (cookie+Bearer), with its own explicit thread-access check before streaming.

### Notifications & Push (`/api/v1/notifications/*`, `/api/notifications/*`, `/api/v1/push/*`)
- `GET /api/v1/notifications?limit=&offset=&unreadOnly=` — returns notifications + unread count together.
- `POST /api/v1/notifications/read` — mark-all-as-read.
- `GET/PUT /api/v1/notifications/preferences` — per-`eventType` toggle of email/in-app/push channels.
- `GET /api/notifications/stream` — SSE, dual-auth, 10s poll, sends unread count on connect and only re-counts when new notifications actually arrive (deliberate DB-load optimization).
- `GET /api/notifications/unread-count` — **cookie-only, no Bearer fallback** (inconsistent with the rest of the notification surface — flagged below).
- `POST /api/v1/push/subscribe` — cookie+Bearer, accepts either a Web Push subscription (`endpoint/p256dh/auth`) or an Expo push token (`ExponentPushToken[...]` regex-validated, `platform: ios|android`) via a discriminated Zod union — this is the route the Expo mobile app registers device tokens through.
- `POST /api/v1/push/unsubscribe` — removes a Web Push subscription by endpoint.

### Selections — agent-branded villa shortlists (`/api/v1/selections/*`, public `/api/selections/*`)
This is a proposal/shortlist feature: an agent curates a set of villas for a specific client, the client (unauthenticated, off-platform) views/favorites/requests them via a shareable link.
- `GET/POST /api/v1/selections` — AGENT, list/create selections.
- `GET/PUT /api/v1/selections/[id]` — AGENT; **`GET` fetches the agent's entire selection list and finds the one matching `id` client-side** rather than querying directly — functionally correct (still scoped to the caller) but an inefficient pattern.
- `POST/DELETE /api/v1/selections/[id]/villas` — AGENT, add/remove a property to/from a selection.
- `POST /api/v1/selections/[id]/publish` — AGENT, publishes the selection (presumably `DRAFT→ACTIVE`, gating client-facing visibility).
- `GET/PUT /api/v1/selections/brand` — AGENT, custom branding settings (logo/colors) applied to the client-facing selection page.
- `POST /api/selections/[id]/favorites` — fully public. Client toggles a favorite; must supply a `clientEmail` that case-insensitively matches `Selection.clientEmail` (acts as a lightweight bearer secret in lieu of real auth). Handles the create/delete race via a Prisma `P2002` unique-constraint catch. Emits an Inngest event to notify the agent.
- `POST /api/selections/[id]/request-booking` — fully public, same email-matching gate. Requires `Selection.status === "ACTIVE"` and the target villa to be `CONFIRMED` within the selection. Explicitly does **not** create a `Booking` record — creates a `SelectionBookingRequest` (status `PENDING`) that must first be actioned by the agent. Rejects duplicate pending requests for the same client+villa.
- `POST /api/selections/[id]/views` — fully public, records a page view with IP+UA SHA-256 fingerprint deduplication (max once/hour per fingerprint), fire-and-forget Inngest notification to the agent.
- `POST /api/selections/villa/[id]/confirm` — **cookie-only auth** (no Bearer fallback), for property owners to confirm availability/pricing for a villa within a selection (`PENDING→CONFIRMED`, optional price override). Verifies caller owns the property via a direct DB lookup (not via `getApiAuthContext`).

### Collections — agent's saved-villa lists (`/api/v1/collections/*`)
AGENT-only throughout. `GET/POST /` list/create a collection. `GET/DELETE /[id]` (service-checked ownership). `POST/DELETE /[id]/properties` add/remove a property (max notes length 500 chars).

### Clients — agent's guest CRM (`/api/v1/clients/*`)
- `POST /api/v1/clients` — AGENT only, find-or-create a client by email (also used internally by booking creation).
- `GET /api/v1/clients/[id]` — **any authenticated user, no ownership check** — returns any client's profile by ID regardless of which agent owns the relationship (see Incomplete/Stubs).

### Search (`/api/v1/search/*`)
Both fully public (`auth:false`). `GET /api/v1/search` — filterable property search (country/region/city/dates/guests/bedrooms/price range/amenities), paginated (max 100/page), grid or map view mode. `GET /api/v1/search/markers` — same filter schema, returns lightweight map pin data.

### Upload (`/api/upload/presign`)
`POST` — **cookie-only auth, no Bearer fallback**. Generates an R2 presigned PUT URL after validating: folder (`photos|documents|evidence`), MIME type allowlist per folder (images only for photos/evidence; images+PDF for documents), and a required, server-enforced 15MB max file size. Rate-limited 10/min per user ID.

### Public webhook receivers (not for direct client consumption)
- `POST /api/webhooks/stripe` — verifies signature via `stripe.webhooks.constructEvent` against `STRIPE_WEBHOOK_SECRET` (500s if unconfigured), idempotency-checked against `ProcessedWebhookEvent`, rate-limited 100/min/IP, **always returns HTTP 200** (even on internal processing errors) to stop Stripe retries. Handles `payment_intent.succeeded/payment_failed`, `transfer.created/reversed` (updates `PaymentSplit` status for agent/owner payout tracking), `account.updated` (syncs `payoutsEnabled` on the connected account), `invoice.paid/payment_failed` (bank-transfer flow, matched to a `PROCESSING` payment by `bookingId` metadata). `customer.subscription.*` events are received and recorded as processed but **the switch case is empty** — see Incomplete/Stubs, this is a real wiring gap.
- `POST /api/webhooks/docusign` — HMAC-SHA256 signature verification (`X-DocuSign-Signature-1` header, `timingSafeEqual` comparison); **in production, rejects all webhooks if `DOCUSIGN_WEBHOOK_HMAC_KEY` is unset** (fails closed), permissive in dev. Idempotency key is synthesized from `envelopeId+eventType+recipientId+timestamp`. Handles `recipient-completed`, `recipient-declined` (fires `CONTRACT_DECLINED` notifications to both agent and owner), `envelope-completed` (fallback reconciliation for signers). Always returns 200, including on internal errors.
- `GET/POST/PUT /api/inngest` — the Inngest function-serving endpoint (background job runner), registering ~40 functions covering booking hold/request timeouts, contract signing flow and reminders, deposit release, claim review timeout, payout processing, iCal sync, selection notifications/PDF generation, rating prompts, insurance activation, etc. Not meant for direct client use — internal job orchestration invoked by Inngest's own infrastructure.

### Incomplete / stubs / gaps

- **`apiLimiter` (60 req/min authenticated) is defined in `src/shared/rate-limit/index.ts` but never imported or used anywhere in the codebase.** `createApiHandler` — the factory used by essentially the entire `/api/v1/*` surface (~80 routes) — does not call `rateLimit()` at all. Only the older public routes (`/api/checkout/*`, `/api/ical/*`, `/api/webhooks/*`, `/api/selections/*` public routes, `/api/upload/presign`) are actually rate-limited. The entire authenticated mobile/web API is currently unthrottled.
- **Stripe subscription webhook handling is dead code.** `POST /api/webhooks/stripe`'s cases for `customer.subscription.created/updated/deleted` are empty (comment: "Handled by billing module (Plan 04) -- just record the event"). The intended consumer, `subscriptionSync` in `src/jobs/subscription-sync.job.ts`, is an Inngest function listening for event `stripe/subscription-event` — but nothing in the codebase ever sends that event (`grep` for `"stripe/subscription-event"` only finds the job's own definition/doc comment). Net effect: Stripe-side subscription lifecycle changes (trial ending, payment failure → past_due, cancellation via Stripe's customer portal) are never synced back into the local `AgentSubscription` table through the webhook path.
- **`PATCH /api/v1/auth/profile` lets any authenticated user set their own role to `ADMIN`** with zero additional checks (`switchRoleSchema` accepts `"OWNER"|"AGENT"|"ADMIN"` and the handler just does `prisma.userProfile.update({ data: { role: input.role } })`). Self-service privilege escalation to platform admin. File: `src/app/api/v1/auth/profile/route.ts`.
- **Missing ownership/authorization checks on several booking-scoped resources** — a systemic pattern across the contracts and payments modules where the route requires *authentication* but not that the caller is party to the specific `bookingId`:
  - All of `/api/v1/contracts/[bookingId]/{route,download,sign,void}` — any authenticated user can generate a contract, fetch a presigned download URL for the signed PDF, obtain an embedded DocuSign signing URL for either "agent" or "owner", or void a contract for any booking ID.
  - `POST /api/v1/deposits/[bookingId]` and `POST/GET /api/v1/payments`, `/api/v1/payments/[bookingId]`, `/api/v1/payments/intent` — no verification the caller is the booking's agent or the property's owner before creating a payment/deposit or reading payment history.
  - `GET /api/v1/listings/[id]` — returns full listing detail (including DRAFT/unpublished) to any authenticated user, unlike every mutating listing sub-route which does call `verifyAccess`.
  - `GET /api/v1/clients/[id]` — returns any agent's client profile to any authenticated user, no ownership check.

  (Compare with `messaging`, `reputation`, and `calendar` modules, which correctly enforce agent/owner/admin membership on every operation — this is not a universal gap, just an inconsistently-applied one concentrated in contracts/payments/deposits/listings-read/clients-read.)
- **`/api/v1/connect/onboard` builds a Stripe return/refresh URL pointing at `${appUrl}/api/v1/connect/callback`, which does not exist** anywhere in the app (no `route.ts`, no page). The equivalent *web* flow (`src/app/(owner)/owner/settings/stripe/actions.ts`) correctly redirects to `/settings/stripe`. The mobile/API-consumer version of Stripe Connect onboarding currently redirects the user's browser to a 404 after they finish onboarding on Stripe's hosted page.
- **No DELETE route for iCal feeds.** `icalImportService.removeFeed()` and a conflict-resolution function exist and are fully implemented in `src/modules/calendar/ical-import.service.ts`, but `/api/v1/calendar/[propertyId]/ical/route.ts` only exports `GET` and `POST` — there is no way to remove a connected external calendar feed or resolve a sync conflict through the API.
- **Inconsistent mobile-auth support (cookie-only, no Bearer fallback)** on three routes that otherwise look like they should support mobile clients: `POST /api/upload/presign`, `GET /api/notifications/unread-count`, `POST /api/selections/villa/[id]/confirm`. Every comparable route elsewhere in the app implements the cookie-then-Bearer dual check; these three don't, so an Expo client authenticating purely via Bearer token cannot use them as-is (uploads in particular would block any mobile photo/document upload flow unless there's an undiscovered separate path).
- **Duplicated checkout-token validation logic.** `/api/checkout/[bookingId]` (GET) and `/api/v1/payments/checkout` (GET, via `paymentsService.getCheckoutData`) independently reimplement the same "look up Payment by checkoutToken, verify it matches bookingId, check expiry/status" logic rather than sharing one implementation — a maintenance/drift risk, not a missing feature.

**Key files**: `src/shared/utils/create-api-handler.ts`, `src/shared/auth/guards.ts`, `src/shared/auth/roles.ts`, `src/shared/rate-limit/index.ts`, `src/modules/bookings/{bookings.service,bookings.types,bookings.schema}.ts`, `src/modules/listings/listings.service.ts`, `src/modules/contracts/contracts.service.ts`, `src/modules/payments/payments.service.ts`, `src/modules/deposits/deposits.service.ts`, `src/modules/claims/claims.service.ts`, `src/modules/calendar/{calendar.service,ical-import.service}.ts`, `src/app/api/webhooks/{stripe,docusign}/route.ts`, `src/jobs/subscription-sync.job.ts`.

---

## Mobile-Responsive Web & PWA (Shipped)

This is genuinely shipped, production code — confirmed by git history: `feat(19-01)` through `feat(20-04)` commits (`b1ab421` → `5ae4d3b`) built this incrementally, culminating in `ea416c3 docs(20-03): complete swipe actions plan - v1.1 milestone complete` and `72b75ba wip: v1.1 complete — paused at milestone close`, both dated **2026-03-16**, matching the milestone date exactly. All dependencies (`react-swipeable-list@1.10.0`, `web-push@3.6.7`, `expo-server-sdk@6.1.0`, `@tanstack/react-table@8.21.3`) are real entries in `package.json`, not aspirational imports. No TODO/FIXME/stub markers found anywhere in the audited files.

### PWA installability

- **Manifest**: `src/app/manifest.ts` uses Next.js's native `MetadataRoute.Manifest` export (no `next-pwa` plugin) to declare name "NexLet - Luxury Villa Booking", `display: "standalone"`, `theme_color: #0f172a`, portrait-primary orientation, and three icon entries (192x192, 512x512, and a 512x512 `maskable` variant). Actual PNG assets exist at `public/icons/icon-192x192.png` (3.5KB) and `icon-512x512.png` (11KB) — both real files, not placeholders/empty.
- **Service worker registration**: `src/app/layout.tsx` inlines a `<script>` in `<head>` that registers `/sw.js` on window `load`, guarded by `'serviceWorker' in navigator`.
- **Service worker** (`public/sw.js`, 60 lines): explicitly scoped to push notifications only — the top comment says "no caching." Handles `install` (skipWaiting), `activate` (clients.claim), `push` (parses JSON payload, shows notification with vibrate pattern, tag/renotify for dedup, and calls `navigator.setAppBadge` if a badge count is in the payload), and `notificationclick` (focuses an existing window and navigates it, or opens a new one).
- **iOS PWA meta tags**: root layout sets `apple-touch-icon`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, and Next's `appleWebApp` metadata block.
- **Install prompt UI** (`src/components/pwa/install-prompt-banner.tsx`): captures the Chrome/Edge `beforeinstallprompt` event via a ref, shows a dismissible card. Concrete gating logic: only shows after **3+ page views** (tracked via `localStorage` `nexlet-visit-count`, incremented by `PwaManager`), suppressed if already dismissed within the last **30 days** (`Date.now()` diff against a stored timestamp), and suppressed entirely if `display-mode: standalone` matches (already installed). On iOS (`/iPad|iPhone|iPod/` UA sniff), shows manual "Share > Add to Home Screen" instructions since `beforeinstallprompt` doesn't fire there.
- **Viewport**: `viewportFit: "cover"` is set in `layout.tsx`, and `.safe-area-bottom` (`padding-bottom: env(safe-area-inset-bottom)`, in `src/app/globals.css`) is applied to `BottomNav` for notched-device support.

### Web push notifications

- **Opt-in banner** (`src/components/pwa/push-permission-banner.tsx`): appears only after visit #2, only if `Notification`/`PushManager`/`serviceWorker` are supported, and only if permission is not already `granted`/`denied`. On enable: requests permission, awaits `serviceWorker.ready`, subscribes via `PushManager.subscribe` using a VAPID public key (base64url→Uint8Array conversion done manually), then POSTs the subscription (`endpoint`, `p256dh`, `auth`, `userAgent`) to the server action `subscribeToPush`.
- **Server-side subscribe action** (`src/modules/push/push.actions.ts`): Zod-validated (`endpoint` must be a valid URL, `p256dh`/`auth` non-empty strings), wrapped in `createAction` for auth+error handling.
- **Push service** (`src/modules/push/push.service.ts`): dual-channel design — `pushService.subscribe` upserts a `PushSubscription` row (unique on `userId_endpoint`) tagged `tokenType: "WEB"`, while a separate `subscribeExpo` path exists for native app tokens tagged `tokenType: "EXPO"` (this confirms the Expo mobile app and this web PWA share the same subscription table/send path). `sendToUser` fans out: web subs go through `web-push`'s `sendNotification` (1hr TTL), Expo subs go through `expo-server-sdk`'s chunked send API. Both paths **auto-prune dead subscriptions** — web: on HTTP 410/404 from the push service; Expo: on `DeviceNotRegistered` receipt errors.
- VAPID keys gracefully no-op if unset (`if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT)`), and the banner shows a toast error ("Push notifications are not configured") rather than crashing if the public key env var is missing client-side.
- **App badge sync**: `PwaManager` (`src/components/pwa/pwa-manager.tsx`) hits `/api/notifications/unread-count` on window `focus` and on mount, and calls `navigator.setAppBadge`/`clearAppBadge` if the API is supported. The API route (`src/app/api/notifications/unread-count/route.ts`) is a real authenticated Supabase-backed endpoint, not a mock.

### Mobile interaction patterns

- **`useIsMobile` hook** (`src/hooks/use-is-mobile.ts`): thin wrapper over `useMediaQuery("(max-width: 767px)")` (`src/hooks/use-media-query.ts`), which is an SSR-safe `matchMedia` listener. Notable deliberate choice: server-render default is `true` (assumes mobile) to avoid a "desktop flash" on phones, accepting a hydration mismatch on desktop that the code comments say React 19 handles as non-blocking.
- **Bottom tab navigation** (`src/components/layout/bottom-nav.tsx`): fixed bottom nav (`md:hidden`), used in all three role layouts — agent (`AGENT_TABS`: Dashboard/Search/Bookings/Messages), owner (`OWNER_TABS`: Dashboard/Listings/Bookings/Messages), admin (`ADMIN_TABS`: Dashboard/Applications/Properties). Tapping the already-active tab scrolls to top instead of navigating. A "More" tab opens a `Drawer` (vaul) listing overflow nav sections not in the primary 4 tabs (computed by filtering `AGENT_SECTIONS`/`OWNER_SECTIONS` against the primary hrefs in `sidebar-nav.tsx`).
- **Mobile header** (`src/components/layout/mobile-header.tsx`): sticky top bar (`md:hidden`) with portal name, `NotificationBell`, and a tap-to-open account drawer (fetches `/api/auth/me` for the user's initial).
- **Floating action button** (`src/components/layout/floating-action-button.tsx`): fixed circular "+" button (`md:hidden`), route-aware — hidden on a per-role list of `hiddenPatterns` (e.g., hidden on `/agent/bookings/new` itself so it doesn't overlap the form it links to).
- **Responsive modal system** (`src/components/ui/responsive-modal.tsx`): a single `ResponsiveModal`/`ResponsiveModalContent`/etc. API that renders as a `Dialog` on desktop, a `Drawer` (bottom sheet, swipe-to-dismiss via vaul) on mobile web, or a `Sheet` specifically when running as an **installed iOS PWA in standalone mode** (`isIosPwaStandalone()` in `src/lib/platform.ts`, checking `navigator.standalone` / `display-mode: standalone` + iOS UA). The comment in `platform.ts` explains why: vaul's swipe-to-dismiss gesture conflicts with iOS's own standalone-mode swipe-back gesture, so Sheet is used as a safer fallback in that specific context. There's also a `ResponsiveAlertModal` variant that additionally disables drawer dismiss-by-swipe for destructive confirmations. Used throughout: date pickers, table filter/sort drawers, mobile search filters.
- **Swipe actions on list items** (`src/components/swipeable/`, built on `react-swipeable-list`):
  - `SwipeableBookingItem`: status-driven leading/trailing actions — leading swipe = Approve (only if `status === "REQUESTED"`), trailing swipe = Decline (if `REQUESTED`) or Cancel (if `APPROVED`/`CONTRACTED`/`CONFIRMED`), calling real server actions (`approveBooking`, `declineBooking`, `cancelBooking`) then `router.refresh()`. If neither action applies to the current status, it renders children unwrapped (no dead swipe affordance). Used in both `agent/bookings/booking-list-item.tsx` and `owner/bookings/booking-list-item.tsx`, gated by `useIsMobile()` — desktop gets the plain row, mobile gets the swipe wrapper.
  - `SwipeableThreadItem`: leading swipe = "Mark read" (only if unread), trailing swipe = "Archive" (always, marked `destructive`), calling `markThreadAsRead`/`archiveThread`. Used inside `src/components/messaging/inbox.tsx`'s `ThreadGroup`, mobile-only.
  - Both use `Type.IOS` swipe styling with a 0.25 threshold and `fullSwipe={false}` (requires explicit tap on the revealed action, not a full-swipe auto-trigger).
- **Master-detail messaging inbox** (`src/components/messaging/inbox.tsx`): on mobile, selecting a thread replaces the list view (`mobileShowThread` state toggling `hidden md:flex` classes) rather than using a permanent split-pane; a `onBack` callback in `ConversationThread` returns to the list. This is a genuine mobile-specific navigation pattern, not just CSS reflow.
- **Data tables → mobile card view fallback** (`src/components/data-table/`): `DataTable` accepts an optional `renderCard` prop; when `isMobile && renderCard`, it renders `DataTableToolbar` (search + sort-drawer + filter-drawer icon buttons with an active-filter-count pill) plus a stack of caller-supplied cards instead of the `<table>`, with compact prev/next pagination. **All 5 real consumers of `DataTable` in the codebase supply `renderCard`** (confirmed by grep — no table is left desktop-only): `sub-agent-list.tsx`, `team-bookings-table.tsx`, `admin-dashboard-client.tsx` (agent applications + property submissions, two tables), `payout-table.tsx`, `payment-table.tsx`. Each has a dedicated card component in `src/components/cards/` (`sub-agent-card`, `team-booking-card`, `agent-application-card`, `property-submission-card`, `payout-card`, `payment-card`). Sort and filter both open through `ResponsiveModal`-based drawers (`DataTableSortDrawer`, `DataTableFilterDrawer`) rather than inline table-header controls.
- **Mobile search experience**: `SearchFilters` (`src/components/search/search-filters.tsx`) branches to a completely different mobile component, `MobileSearchFilters` (`src/components/search/search-filters-mobile.tsx`), when `useIsMobile()` is true — not just CSS reflow of the same markup. Mobile gets a compact bar (search-icon button + horizontally-scrolling active-filter chip row with per-chip clear buttons + clear-all) that opens a full-screen `ResponsiveModal` filter sheet with a local "pending" filter state that's only committed to the URL (`nuqs` query state) on "Apply Filters". `SearchViewToggle`/`MapListToggle` render a floating pill button (fixed bottom, above the bottom nav) to toggle grid/map view — desktop just shows both side-by-side buttons in the filter bar instead.
- **Mobile-aware React Query defaults**: `src/components/providers/query-provider.tsx` sets `staleTime` to 5 minutes on mobile vs 1 minute on desktop (bandwidth-conscious caching), recalculated via `useIsMobile()` on every render and applied via `setDefaultOptions` (comment notes this affects only new queries, not already-cached ones).
- **Availability calendar**: `src/components/calendar/availability-calendar.tsx` swaps full day names ("Sun", "Mon"...) for single-letter abbreviations on mobile, uses larger touch targets (`size-11` nav buttons vs `size-9` desktop), and changes instructional copy from "Click" to "Tap".
- **Date picker**: `src/components/ui/date-picker-drawer.tsx` renders a `Popover`+`Calendar` on desktop but a full `ResponsiveModal` bottom sheet with explicit Clear/Confirm buttons and a larger 44px calendar cell size on mobile, plus a taller trigger button (`max-sm:h-11` vs `h-9`) for easier tapping.

### Incomplete/stubs

- **Bottom-nav badge counts are dead code in practice.** `BottomNav` accepts and renders a `badgeCount?: Record<string, number>` prop (red dot with unread count per tab), and the rendering logic (`badgeCount?.[tab.href] ?? 0`) is fully implemented — but none of the three call sites (`(agent)/layout.tsx`, `(owner)/layout.tsx`, `(admin)/layout.tsx`) ever pass `badgeCount`. So the bottom-nav badges will never actually appear; only the sidebar/header `NotificationBell` (SSE-driven) and the PWA app badge (via `setAppBadge`) surface unread counts today.
- **`DataTableEmpty`'s `isFiltered` prop is plumbed in but silently dropped.** `data-table.tsx` computes `isFiltered={table.getState().columnFilters.length > 0}` and passes it to `DataTableEmpty`, but `DataTableEmpty`'s destructuring (`{ message, icon, action }`) never reads it — so the mobile card-view empty state can't currently show a different message/action for "no results due to active filters" vs. "genuinely no records," despite the data being available.
- **Manifest icon set is minimal.** Only two source PNGs exist (192x192, 512x512); the 512 is reused for both the standard and `maskable` manifest entries rather than a dedicated safe-zone maskable asset. No apple-touch-icon sizes beyond the 192px one referenced in `layout.tsx`, no favicon variants, no screenshots array (which some install UIs use for a richer install prompt).
- **Service worker does no offline caching** — this is explicit and intentional per its own top comment ("Push notifications only (no caching)"), not a bug, but worth noting: there is no offline page, no asset precaching, no `CacheStorage` usage anywhere in `sw.js`. If network is unavailable, the app behaves like a normal web page (fails to load), not a resilient offline-capable PWA.

**Key files**: `src/components/pwa/{pwa-manager,install-prompt-banner,push-permission-banner}.tsx`, `src/app/manifest.ts`, `public/sw.js`, `src/app/layout.tsx`, `src/modules/push/{push.actions,push.service,push.types}.ts`, `src/components/swipeable/{swipeable-booking-item,swipeable-thread-item}.tsx`, `src/components/data-table/*.tsx`, `src/components/layout/{bottom-nav,mobile-header,floating-action-button,sidebar-nav}.tsx`, `src/components/ui/responsive-modal.tsx`, `src/lib/platform.ts`, `src/hooks/{use-is-mobile,use-media-query}.ts`, `src/app/(agent)/layout.tsx`, `src/app/(owner)/layout.tsx`, `src/app/(admin)/layout.tsx`, `src/components/messaging/inbox.tsx`, `src/components/search/{search-filters,search-filters-mobile,map-list-toggle,search-view-toggle,property-grid}.tsx`, `src/components/calendar/availability-calendar.tsx`, `src/components/ui/date-picker-drawer.tsx`, `src/components/providers/query-provider.tsx`.

---

## Mobile App — Expo Rewrite (In Progress)

**Overall maturity assessment: substantially further along than a typical "in-progress rewrite."** Nearly every screen across all three roles (admin, agent, owner) is wired to real TanStack Query hooks hitting the actual Next.js `/api/v1/*` REST endpoints — not mock data, not hardcoded arrays. There is real business logic client-side (status filtering, cancellable-status checks, stat computation), real native capability usage (biometrics, haptics, Stripe PaymentSheet with Apple/Google Pay, push notifications, camera/photo picker, deep links, native maps, DocuSign browser handoff), and even a monorepo-shared Zod validation schema imported directly from the Next.js web app (`apps/mobile/app/(agent)/apply/index.tsx` imports `agentApplicationSchema` from `src/modules/agents/agents.schema.ts` via a `@/*` path alias into the web app's own source tree — confirmed to exist at `src/modules/agents/agents.schema.ts`). The gaps that exist are narrow and specific, not "screen is a shell."

### Architecture / plumbing
- **Auth**: `src/providers/auth-provider.tsx` — Supabase session management with `LargeSecureStore` (`src/lib/large-secure-store.ts`, AES-256-CTR encryption, key in `expo-secure-store`, ciphertext in `AsyncStorage`, working around SecureStore's 2048-byte limit on JWTs), auto-refresh tied to `AppState`, optional biometric gate on cold start (Face ID/fingerprint via `expo-local-authentication`, `src/lib/biometrics.ts`), and a post-sign-in biometric opt-in prompt. Role is fetched server-side via `GET /api/v1/auth/me` and cached in context.
- **Routing/guards**: `app/_layout.tsx` uses Expo Router `Stack.Protected` to gate `(auth)`, `onboarding`, `(agent)`, `(owner)`, `(admin)` groups by `session` + `role`. Real, not decorative.
- **API client**: `src/lib/api-client.ts` + `src/lib/api.ts` — generic typed client injecting the Supabase bearer token per-request, parsing a `{success, data}` / `{success:false, error, code}` envelope, throwing a typed `ApiError` with `.isUnauthorized/.isForbidden/.isValidationError` helpers. Every hook in `src/hooks/` (29 files, ~2,400 lines) goes through this client — confirmed by reading all of them.
- **State**: TanStack Query for all server state (proper `queryKey` invalidation on every mutation — approve/reject/cancel/archive all invalidate both list and detail caches); Zustand for two multi-step wizard stores (`application-wizard-store.ts`, `listing-wizard-store.ts`), explicitly in-memory only (documented decision: survives tab switches, not app kill).

### Admin role
- **Dashboard** (`app/(admin)/dashboard/index.tsx`): real stat cards (pending agents/properties, totals, revenue) via `useAdminDashboard`, which calls `/admin/counts` and `/admin/agents?status=PENDING` in parallel with `Promise.allSettled` (partial-failure tolerant), plus a live pending-applications list with real avatars/dates.
- **Agent review queue** (`app/(admin)/agents/index.tsx`, `[id].tsx`): status-tab filtering (All/Pending/Approved/Rejected/Revoked) hitting the real `?status=` query param server-side, swipe-to-approve/reject gesture row, a full detail screen with approve (confirm dialog → `POST /agents/:id/approve`) and reject (modal requiring a non-empty rejection reason → `POST /agents/:id/reject`) flows, with loading/error states and cache invalidation.
- **Property review queue** (`app/(admin)/properties/index.tsx`, `[id].tsx`): status tabs (Draft/Pending Review/Approved/Published/Rejected), full property detail (photos, owner info, amenities, seasons, availability calendar) with state-gated action buttons: `PENDING_REVIEW` → Approve/Reject (reject requires typed reason), `APPROVED` → Publish. Real `POST /admin/properties/:id/{approve,reject,publish}`.

**Incomplete/stub**: `app/(admin)/settings/index.tsx` is a literal one-line placeholder (`<Text>Settings - Admin</Text>`, 11 lines total) — no navigation, no sign-out, nothing. This is the one genuinely unbuilt screen in the entire admin section.

### Agent role
- **Dashboard** (`use-agent-dashboard.ts`): computed client-side from parallel `/bookings`, `/clients`, `/teams` fetches — active/pending booking counts derived from real status filtering, recent-bookings sort. `commissionEarned` field is hardcoded to the string `"Coming soon"` (explicitly, not silently) — genuinely not computed since there's no commission-calculation logic anywhere in the mobile hooks.
- **Search** (`app/(agent)/search/index.tsx`, `[id].tsx`): debounced text search (300ms), filter bottom sheet (location/dates/guests/price/amenities), list/map toggle. Property detail is fully built: photo gallery, amenity grid, seasonal pricing summary, availability calendar, native mini-map (lazy `require("react-native-maps")` to avoid web bundling), share sheet, add-to-collection, and a booking-request bottom sheet with real Zod-validated form (dates, guest count with +/- stepper, guest contact, agent notes) posting to `POST /bookings`.
  - Minor gap: `useMapMarkers` is called with `enabled: view==="map"` but **no `bounds` are ever passed** from the search screen — the map view always fetches a fixed/global marker set rather than being viewport-aware (pan/zoom doesn't refetch).
- **Bookings** (`index.tsx`, `[id].tsx`): status-tab list, swipe-to-cancel/archive, full detail screen with timeline, price breakdown, contract section (DocuSign sign/download), payment section (Stripe PaymentSheet), deposit timeline, and status-gated cancel button (`REQUESTED/APPROVED/CONFIRMED`).
- **Clients** (`index.tsx`, `[id].tsx`): full CRUD — list with pull-to-refresh, create via modal form, edit via detail screen, both hitting real `/clients` endpoints.
- **Collections & Selections** (both list/detail/create): fully wired CRUD, add/remove villa from collection or selection, publish-a-selection (`POST /selections/:id/publish`) that makes it accessible via public slug, and a real native share sheet (`Share.share`) building a URL from `EXPO_PUBLIC_APP_URL`. The `s/[slug].tsx` deep-link route and `app/(agent)/selections/[id].tsx` reuse the same slug as the route param, which is correct only because Expo Router treats `id` and `slug` params interchangeably here — worth double-checking against the web app's slug vs UUID convention, but functionally wired either way.
- **Messages**: `ThreadListScreen` (grouped inbox — Active/Pending/Past sections, swipe to mark-read/archive) and `ChatScreen` (inverted FlatList, SSE live updates via `react-native-sse` connecting/disconnecting on screen focus/blur, optimistic send). This is a real-time chat implementation, not a stub.
- **Team management** (`settings/team.tsx`): member list + pending invites, invite-by-email form, deactivate-with-reassignment mutation.
- **Agent application wizard** (`apply/index.tsx` + `forms/application-wizard/`): 5-step wizard (business credentials, insurance/licensing with document upload, track record, references, review) using react-hook-form + shared Zod schema from the web app, submitting to `POST /agents/application`. Status-check gate shows Pending/Approved/Rejected states with review notes before showing the wizard.
- **Listing creation** (`listings/create.tsx` + `forms/listing-wizard/`): 6-step wizard (basic info, location, amenities, photo upload via presigned R2 URLs, pricing, review) that does a real multi-step submit sequence: create listing → upload each photo → register photos → set amenities → submit for review. Reused by the owner's "Add Property" and "Edit Property" flows (edit mode pre-fills the Zustand store from `useListing` and PUTs instead of POSTs).
- **Settings** (`settings/index.tsx`): navigation hub is real for Team/Clients/Payment History/Notifications, but **"Privacy & Security" and "Sign Out" are both no-op `onPress={() => {}}`**. Confirmed by grep: `signOut` (defined and exported by `auth-provider.tsx`) is never called anywhere in the app UI. There is currently no way to sign out of the mobile app through any screen.

### Owner role
- **Dashboard**: same pattern as agent (parallel `/bookings` + `/listings` fetch, client-computed revenue/occupancy stats).
- **Properties** (`index.tsx`, `[id]/index.tsx`, `edit.tsx`, `calendar.tsx`, `pricing.tsx`): list screen uses an ad-hoc inline `useQuery` against `/listings` rather than a shared hook (minor inconsistency, not a bug — still real data). Detail screen shows stats, description, and links to Edit/Calendar/Pricing. Calendar screen (`EditableAvailabilityCalendar`) is a real tap-to-select-range block/unblock UI hitting `POST /calendar/:id/{block,unblock}`, rendering two month grids with season color-coding and booked/blocked states pulled from `GET /calendar/:id`. Pricing screen supports adding/deleting seasons with real client-side validation (price ≥ $1.00, min stay ≥ 1 night) against `POST/DELETE /listings/:id/seasons`.
- **Bookings** (`index.tsx`, `[id].tsx`): approve/decline/cancel/archive, decline requires a typed reason via modal, status-gated action bar (`REQUESTED` → approve/decline; `APPROVED/CONFIRMED` → cancel).
- **Payouts** (`settings/payouts.tsx`): full Stripe Connect flow — not-connected/needs-onboarding/fully-set-up states, `POST /connect/onboard` opens Stripe onboarding in system browser via `expo-web-browser`, Express dashboard link, refetches status on return.
- **Messages**: identical shared `ThreadListScreen`/`ChatScreen` components as agent.
- **Settings**: same pattern as agent — Notifications and Payouts rows work, **"Privacy & Security" and "Sign Out" are both no-op** (same confirmed gap as agent settings).

### Shared native capabilities actually implemented (verified, not aspirational)
- **Biometrics**: `expo-local-authentication` + `expo-secure-store` opt-in gate, `src/lib/biometrics.ts`.
- **Haptics**: `expo-haptics` wrapped in `src/lib/haptics.ts` (light/success/selection), used consistently on swipe actions and payment success across booking/thread screens.
- **Push notifications**: `src/hooks/use-push-notifications.ts` + `src/providers/notification-provider.tsx` — real Expo push token registration (`POST /push/subscribe`), Android notification channel setup, physical-device guard, permission-prompt tracking via AsyncStorage (won't re-prompt after denial), and notification-tap deep-link navigation (`router.push(data.url)`).
- **Camera/photo/document picker**: `src/hooks/use-upload.ts` uses `expo-image-picker` and `expo-document-picker`, uploads to R2 via a presigned-URL flow (`POST /api/upload/presign`, outside the `/api/v1` namespace — correctly documented).
- **Payments**: `@stripe/stripe-react-native` PaymentSheet with Apple Pay / Google Pay config, conditionally `require()`'d only on native (web shows a "use web checkout" message) — `src/components/booking/payment-section.tsx`.
- **Maps**: `react-native-maps` with platform-split files (`map-view.native.tsx` uses Apple Maps on iOS / Google Maps on Android via `PROVIDER_GOOGLE`; `map-view.web.tsx` shows a "map available on mobile" placeholder). Property detail also renders a small native-only static mini-map. **No `expo-location`/GPS "use my location" anywhere** — maps are marker/property-driven only, no user-location feature.
- **Deep links / universal links**: `app.config.ts` registers `associatedDomains` (iOS) and Android `intentFilters` for `nexlet.com/{bookings,s,auth,contracts}` paths; `app/auth/callback.tsx` (OAuth + password reset), `app/contracts/callback.tsx` (DocuSign signing return), `app/s/[slug].tsx` (shared selection links) are all real, functioning redirect handlers.
- **DocuSign contract signing**: `src/hooks/use-contracts.ts` opens the DocuSign embedded-signing URL in the system browser (`expo-web-browser`) with a deep-link return URL, and separately downloads/shares signed PDFs (`expo-file-system` + `expo-sharing` on native, direct URL open on web).
- **Sentry**: wired at the root (`Sentry.wrap(RootLayout)`, `src/lib/sentry.ts`).
- **Testing**: only 3 test files exist in the entire mobile app — `api-client.test.ts`, `large-secure-store.test.ts`, `auth-provider.test.ts`. No component or screen-level tests.

### Incomplete/stubs (exhaustive list)
1. **`app/(admin)/settings/index.tsx`** — 11-line static placeholder, no functionality at all (no sign-out even here).
2. **Sign-out is unreachable from the UI everywhere.** `useAuth().signOut()` exists and works, but both `app/(agent)/settings/index.tsx` and `app/(owner)/settings/index.tsx` bind the "Sign Out" row to `onPress={() => {}}`, and the admin settings screen doesn't have a sign-out row at all. Confirmed via `grep -rln signOut` — the only match in the whole app is the definition in `auth-provider.tsx`.
3. **"Privacy & Security" row is a no-op** in both agent and owner settings (`onPress={() => {}}`) — present in the UI, does nothing.
4. **`app/onboarding/index.tsx` is a dead-end stub.** It's a static "Role Selection... Choose your role to continue" screen with zero interactivity and zero navigation to `app/onboarding/role.tsx`, which is the actual fully-built, functional role-picker screen (name inputs, three role cards, `POST /auth/profile`, `setRole()`). Since the root `_layout.tsx` routes any authenticated-but-roleless user to the `onboarding` group, and Expo Router defaults an unspecified group route to its `index`, new users who complete sign-up land on the non-functional stub, not the real picker — confirmed no `Redirect`/router-push exists anywhere connecting the two files. This looks like a genuine, functional dead end in the new-user flow rather than a cosmetic gap.
5. **Agent-dashboard "commission earned" stat is hardcoded to `"Coming soon"`** (`use-agent-dashboard.ts`) — explicitly unimplemented, not silently wrong.
6. **Five unused UI components** (`src/components/ui/calendar.tsx`, `command.tsx`, `data-table.tsx`, `date-picker-drawer.tsx`, `responsive-modal.tsx`, ~520 lines combined) are exported from the `ui/index.ts` barrel but never imported by any screen — dead code, not wired into any flow (possibly ported from a shared/shadcn source and never integrated).
7. **`ContractSection`'s sign action hardcodes `signerRole: "agent"`** even though the same component is reused verbatim on the owner's booking-detail screen (`app/(owner)/bookings/[id].tsx`) — a code comment claims "the API determines actual role from auth context," which may make the parameter inert server-side, but it's worth verifying against the actual API route rather than trusting the comment, since it reads as a latent bug if the server ever does trust the client-supplied role.
8. **Map search has no viewport-bounds wiring** — `useMapMarkers` is called with `enabled` only, never `bounds`, so panning/zooming the map doesn't refetch a scoped marker set (functions, but not as a true "search this area" map).

### Key files
- Routing/guards: `apps/mobile/app/_layout.tsx`
- Auth: `apps/mobile/src/providers/auth-provider.tsx`, `apps/mobile/src/lib/{supabase,large-secure-store,biometrics,apple-auth,google-auth}.ts`
- API layer: `apps/mobile/src/lib/{api-client,api}.ts`
- All data hooks: `apps/mobile/src/hooks/*.ts` (29 files)
- Role tab layouts: `apps/mobile/app/(admin)/_layout.tsx`, `apps/mobile/app/(agent)/_layout.tsx`, `apps/mobile/app/(owner)/_layout.tsx`
- Stub/gap files: `apps/mobile/app/(admin)/settings/index.tsx`, `apps/mobile/app/(agent)/settings/index.tsx`, `apps/mobile/app/(owner)/settings/index.tsx`, `apps/mobile/app/onboarding/index.tsx` vs `apps/mobile/app/onboarding/role.tsx`
- Native capability wiring: `apps/mobile/src/lib/haptics.ts`, `apps/mobile/src/hooks/use-push-notifications.ts`, `apps/mobile/src/providers/notification-provider.tsx`, `apps/mobile/src/hooks/use-upload.ts`, `apps/mobile/src/providers/stripe-provider.tsx`, `apps/mobile/src/components/search/map-view.{native,web}.tsx`, `apps/mobile/app.config.ts`

---

## Testing & CI Coverage

### What actually runs in CI today

`.github/workflows/ci.yml` defines 4 jobs, triggered on push/PR to `main`:

1. **`lint-and-typecheck`** — `npm run lint` (eslint), `npx biome check .` (biome config excludes `apps/` and `e2e/` from its scope — see `biome.json`), `npm run typecheck` (`tsc --noEmit`).
2. **`test`** ("Unit Tests") — runs `npm test` = `vitest run` against the **default** `vitest.config.mts`, which explicitly includes only `src/**/*.test.ts(x)` and excludes `e2e`. No coverage threshold is enforced — `test:coverage` exists as an npm script but is never invoked in CI.
3. **`build`** — `next build`, caches `.next` for the e2e job.
4. **`e2e`** — depends on `build`, and is gated behind `if: ${{ vars.E2E_ENABLED == 'true' }}`, a GitHub Actions repository *variable* (not a secret). This job also needs three secrets (`E2E_SUPABASE_URL`, `E2E_SUPABASE_ANON_KEY`, `E2E_SUPABASE_SERVICE_ROLE_KEY`). The project's own phase-tracking notes (`.planning/phases/21-e2e-infrastructure-foundation/21-02-SUMMARY.md`, `.planning/phases/23-account-listing-search-tests/.continue-here.md`) record these secrets/variable as **not configured**, corroborating what the workflow file itself shows: unless someone has since flipped that repo variable, the E2E job is skipped entirely on every PR/push, not merely allowed to fail.

Net effect: the only thing that actually gates merges via this workflow is lint/typecheck + a 9-file Vitest unit suite + a successful production build. E2E, adapter tests, and the factory integration test are **not** part of the merge gate as configured.

### Unit/integration tests that DO run in CI (`src/**/*.test.ts`, 9 files, ~1,894 lines)

- **`src/modules/bookings/__tests__/state-machine.test.ts`** — pure data assertions against `VALID_TRANSITIONS` in `bookings.types.ts`: validates the booking state machine's allowed edges (REQUESTED→APPROVED→CONTRACTED→PAID→CONFIRMED→COMPLETED, cancellation branches, terminal states have no outgoing transitions, no skip-ahead or backward transitions). Good, focused coverage of the state graph itself.
- **`src/modules/bookings/__tests__/bookings.service.test.ts`** — service-layer tests with `prisma`, `inngest`, and `bookings.queries` fully mocked via `vi.mock`. Covers `approveBooking` (owner-only, rejects at `maxHoldsPerAgent`), `declineBooking`, `cancelBooking` (agent/owner permission rules, blocked once `PAID`), `transitionState` (rejects invalid transitions), `getBookingById` (access control for agent/owner/admin). This is real logic-path coverage, but entirely at the mocked-dependency level — no real Prisma/Postgres round-trip is exercised.
- **`src/modules/messaging/__tests__/messaging.service.test.ts`** — thread creation (agent-only, one thread per booking), message sending (agent/owner access only), attachment registration (file-type allowlist, size limit, max-attachments-per-message cap), and inbox grouping by booking status (active/pending/past, including null-booking edge case). Same mocked-dependency pattern.
- **`src/modules/payments/__tests__/financial-calculator.test.ts`** — the most substantive test file. Verifies `calculateBookingFinancials` (flat vs. percentage agent markup, platform/agent commission split math with explicit floor-rounding checks, deposit/balance split logic — 30-day-before-checkin threshold forces full payment instead of deposit split, insurance premium folded into deposit but security deposit excluded from client total) and `calculateRefundAmount` (FLEXIBLE/MODERATE/STRICT cancellation-policy tiers with concrete day thresholds — e.g. FLEXIBLE: 100%/≥14d, 50%/7-13d, 0%/<7d; STRICT: 100%/≥60d, 50%/≥30d, 0%/<30d — plus rejection of unknown policy types) and `calculateSimplifiedRefund` (owner-cancels = full refund of paid amounts, client-cancels = zero refund).
- **`src/shared/utils/create-api-handler.test.ts`** — tests the shared API-route wrapper: success envelope, 401 on auth failure, 400/`VALIDATION_ERROR` on zod schema failure, 403/`FORBIDDEN` on role mismatch, `auth: false` bypass, GET query-string parsing through the schema.
- **`src/app/api/v1/auth/me/route.test.ts`** and **`.../auth/profile/route.test.ts`** — route-level tests for the dual-mode (cookie-then-Bearer) auth flow: profile lookup, null-profile "onboarding needed" case, 401 on full auth failure, profile creation (`upsert`) and role `PATCH`, validation rejection of an invalid role.
- **`src/shared/auth/guards.test.ts`** — **stub only**. Literally `expect(true).toBe(true)` with a comment "this scaffold confirms the test file exists for Nyquist compliance" and a `// TODO` list of the real tests to add later. It passes in CI but verifies nothing.
- **`src/__tests__/phases-19-20-audit.test.ts`** — an unconventional test file: it does **static text/regex analysis on source files** (`readFileSync` + `.toMatch(/regex/)`) rather than exercising runtime behavior. It checks things like "push.service.ts contains no hardcoded domain," "sw.js wraps `.json()` in try/catch," "messaging.queries.ts filters archived threads with a `NOT ... has` clause," "search-filters-mobile.tsx resets page to 1 on filter apply." These are real assertions about the PWA/push-notification, messaging-archive, and search-filter code and will fail if that literal source text changes — but they don't run the code, so they can't catch logic bugs, only the presence/absence of certain patterns. Scoped to Phases 19–20 (PWA/push notifications, message archiving, search filters) only.

**Module coverage matrix** — of the 20 business modules under `src/modules/`, only **3 have any unit tests**: `bookings` (2 files), `messaging` (1 file), `payments` (1 file). The other 17 — `admin`, `agents`, `billing`, `calendar`, `claims`, `clients`, `collections`, `contracts`, `deposits`, `insurance`, `listings`, `notifications`, `push`, `reputation`, `search`, `selections`, `teams` — have **zero** unit or integration test files. That includes contract signing (DocuSign), deposits, insurance, claims/disputes, billing/subscriptions, listings CRUD, and search — all business-critical and all untested at the unit level.

### E2E suite (Playwright) — infrastructure is extensive, actual specs are minimal

`e2e/tests/` contains only **two spec files, five test cases total**:
- **`auth.spec.ts`** (2 tests): unauthenticated visit to `/dashboard` redirects to `/sign-in`; unauthenticated visit to `/` does not redirect.
- **`smoke.spec.ts`** (3 tests): an authenticated owner/agent/admin (via pre-saved storage state) can load `/dashboard` and land on their respective role dashboard (or, for a fresh owner with no properties, `/owner/listings/new`).

That is the entirety of what the E2E suite currently verifies: login-gate redirection and role-based dashboard routing. No test in this suite creates a listing, requests or approves a booking, signs a contract, makes a payment, sends a message, or manages availability.

However, the surrounding scaffolding suggests those flows were planned in detail and then not finished:
- **`e2e/pages/`** — three fully-built Page Object Models totaling 517 lines: `booking-flow.page.ts` (agent booking-creation wizard: dates, guest info, notes, submit, pricing-preview and validation-error assertions), `calendar.page.ts` (owner availability calendar: block/unblock days, month navigation), `listing-form.page.ts` (owner's multi-step listing wizard: Basic Info → Location → Capacity → Descriptions → Photos → Amenities → House Rules → Review). **None of these three are imported or referenced by any file in `e2e/tests/`** — confirmed by grep. They're exposed through the `pages` fixture in `e2e/fixtures/test-fixtures.ts` but nothing calls it.
- **`e2e/factories/`** — 8 factory files (`user`, `property`, `booking`, `message`/`thread`, `selection`, `contract`, `payment`) for seeding real Prisma-backed test data, exported via `e2e/factories/index.ts` and also wired into the `factories` fixture. Also unused by the two actual specs.
- **`e2e/fixtures/`** — `test-fixtures.ts` provides `ownerPage`/`agentPage`/`adminPage` (pre-authenticated Playwright `Page` contexts loaded from `e2e/.auth/*.json` storage state) plus automatic per-test cleanup of five in-memory "test adapters" (Stripe/DocuSign/Inngest/Resend/R2 fakes). `auth.setup.ts` logs in as each of the three seeded roles once via the real sign-in form and persists the session.
- **`e2e/helpers/`** — `global-setup.ts`/`global-teardown.ts` seed/clean up three test users (owner/agent/admin) in real Supabase Auth + `UserProfile` rows via `db-seed.ts`, including auto-approving an `AgentApplication` for the agent role so agent-only routes are reachable.
- **`playwright.config.ts`** — configured for 5 projects (auth-setup + owner/agent/admin/logged-out), serial execution (`workers: 1`, with a comment noting parallelism is a future upgrade "if suite exceeds 15 min" — currently moot at 5 tests), retries only in CI, and builds against a production `next build`/`next start` in CI vs. dev server locally.

In short: the *harness* for a much larger E2E suite (booking creation, calendar management, listing wizard, real Prisma-seeded data, faked third-party adapters) exists and looks production-grade, but the actual test coverage riding on top of it is limited to auth redirect + dashboard routing smoke checks.

### `e2e/infra-tests/` — separate Vitest suite testing the *test doubles*, not wired into CI

- **`e2e/vitest.adapters.config.mts`** defines a standalone Vitest config (`include: ["e2e/infra-tests/adapters/**/*.test.ts"]`) run via `npm run test:adapters`. **This script is never invoked anywhere in `ci.yml`** — it must be run manually.
- The five adapter test files (`stripe`, `docusign`, `inngest`, `r2`, `resend` — 439 lines total) test the **in-memory fake adapters** used by E2E tests (`src/shared/adapters/test-adapters/*`), e.g. that `stripeTestAdapter.createPaymentIntent` returns a `pi_test_`-prefixed ID, that `clearState()` empties captured state, that the fake Inngest adapter runs registered handlers synchronously. These confirm the test doubles behave predictably for E2E authors — they say **nothing about correctness of the real Stripe/DocuSign/Inngest/Resend/R2 integrations**.
- **`e2e/infra-tests/factories/factories.test.ts`** (196 lines) validates that the `e2e/factories/*` functions create real Prisma-backed rows with sensible defaults and accept overrides. It's written against Node's built-in `node:test` runner (not Vitest), with a comment saying to run it via `npx tsx e2e/infra-tests/factories/factories.test.ts` — this script isn't in `package.json` and isn't referenced anywhere in CI. It requires a real `DATABASE_URL`, so it's effectively a dev-only manual-run integration check.

### Incomplete/stubs

- **`src/shared/auth/guards.test.ts`** is a placeholder test (`expect(true).toBe(true)`) with an explicit TODO list of the real dual-mode-auth tests that haven't been written yet. It passes in CI but is not a real test.
- **E2E flow coverage for booking creation, calendar/availability management, and the listing wizard does not exist**, despite three complete, well-documented Page Object Models (`booking-flow.page.ts`, `calendar.page.ts`, `listing-form.page.ts`, 517 lines) sitting unused in `e2e/pages/`. Same for the 8 E2E data factories (`e2e/factories/`) — built, fixture-exposed, never called from a spec.
- **`src/test/prisma-mock.ts`**, a shared deep-Prisma-mock helper with auto-reset wiring, is not imported by any of the actual unit test files — they each hand-roll their own narrower `vi.mock` calls against query/service modules instead. Dead scaffolding.
- **The E2E CI job is effectively disabled** as shipped: gated on the `E2E_ENABLED` repo variable plus three Supabase secrets that, per the project's own phase notes, are not configured. So even the 5 auth/smoke E2E tests that do exist have likely never run in CI, only (at best) locally.
- **Adapter tests (`e2e/infra-tests/adapters/`) and the factory integration test (`e2e/infra-tests/factories/factories.test.ts`) are orphaned from CI** — real npm scripts exist (`test:adapters`) or are documented in a comment, but neither is called from `.github/workflows/ci.yml`. They'd presumably pass if run, but nothing currently runs them automatically.
- **`apps/mobile`** (outside this section's core scope but discovered during the sweep) has its own 3 test files (`api-client.test.ts`, `large-secure-store.test.ts`, `auth-provider.test.ts`) and its own `package.json`, but `apps/` is never mentioned in `ci.yml` and is explicitly excluded from the root Biome lint scope — this workspace has no CI test gate at all.
- **No coverage threshold/gate anywhere**: `test:coverage` (`vitest run --coverage`, configured for `src/modules/**` and `src/shared/**`) exists as an npm script but CI never runs it, so there's no enforced minimum and no visibility into actual line/branch coverage percentages.
- **`phases-19-20-audit.test.ts`** is worth flagging as a distinct, brittle category: it verifies source-code *text patterns* (regex on file contents), not runtime behavior, for a narrow slice of the app (PWA/push notifications, message archiving, search-filter reset). It will pass or fail based on incidental refactors (e.g., renaming a variable) independent of whether the underlying logic is actually correct, and it covers none of the 17 untested business modules.

**Bottom line on what's actually verified vs. built-but-unverified:** Of the ~20 business modules, only booking state transitions, the booking service's permission/hold rules, messaging thread/message/attachment rules, and the financial calculator (markup, commission, deposit/balance, refund-policy tiers) have real automated test coverage — and all of it is unit-level with fully mocked Prisma/Inngest, never touching a real database. Contract signing (DocuSign), deposits, insurance, claims, billing/Stripe subscriptions, listings CRUD, search, calendar/availability, admin, agents, collections, reputation, and teams have no automated tests of any kind. End-to-end browser coverage is limited to "logged-out users get redirected" and "logged-in users land on the right dashboard" — every richer flow (create a listing, request/approve a booking, sign a contract, pay a deposit, message a counterparty, block calendar dates) is unverified by any currently-running automated test, notwithstanding the substantial Page-Object/factory infrastructure built in anticipation of testing them.

---

## Incomplete / Not Yet Verified

This section pulls together every gap flagged in the 12 sections above — built-but-broken, built-but-disconnected, schema-only, or simply untested — into one scannable index. Each item links back conceptually to its full write-up in the relevant section above; file references are kept so they're actionable.

### 1. Property Listings, Search & Calendar
- No UI/action anywhere sets `CancellationPolicy` — every property is stuck on the hardcoded `MODERATE` fallback.
- `Property.cleaningFeeCents` has no form field — owners can't set it above `0`.
- `PropertyStatus.SUSPENDED` is unreachable — no way to pull a published listing down.
- Bulk calendar range block/unblock (`blockDateRange`/`openDateRange`) is fully built server-side with zero UI callers.
- No availability calendar is ever shown to agents or the public, only to the owner.
- Search's amenities filter is OR not AND — selecting more chips widens results, not narrows them.
- `minimumStayNights` on a `Season` is decorative — never enforced by search or booking creation.
- Search pagination (`?page=`) drops every other active filter.
- `searchProperties`/`getMapMarkers` server actions have no auth check of their own (page-level gating only).
- Photo-upload presign endpoint doesn't verify the caller owns the target `propertyId`.
- Listing/calendar mutation actions carry no `role` restriction, only object-level ownership checks.
- `listings`, `search`, and `calendar` modules have zero automated test coverage.
- A second, thinner iCal REST endpoint duplicates the server-action flow with unclear purpose.

### 2. Bookings, Contracts & Deposits
- Security deposit charge confirmation is never wired server-side — deposits get stuck at `PENDING` forever even when Stripe successfully charges the client; the entire 7-day hold → release → claim pipeline silently never runs.
- Instant-book properties never get a `SecurityDeposit` record at all, regardless of configuration.
- The generated/signed contract PDF always discloses a security deposit of €0, independent of the above.
- A CONFIRMED or PAID booking cannot be cancelled through any exposed code path — refunds move money but never update `Booking.status` or release calendar dates.
- `checkout` GET response's `pricing.securityDepositCents` field is always `0` and appears unused/vestigial.
- `depositsQueries.getDepositsForRelease()` (a cron safety-net query) has no caller anywhere.
- No test coverage exists for `deposits` or `contracts` modules.

### 3. Payments, Billing, Insurance & Claims
- Security-deposit charging on the standard checkout page is very likely non-functional end-to-end (`confirmCardPayment` called with no attached payment method, no retry job despite UI copy claiming one).
- `subscriptionSync` (Stripe subscription tier sync) is fully built but structurally unreachable — the webhook that should trigger it never emits the event.
- The owner's deposit-installment payout share is computed but never transferred — only the balance-installment share ever reaches the owner's Stripe account.
- `totalSplitVerification` (owner+agent+platform reconciliation flag) is computed and never read anywhere.
- `onPayoutCompleted` reads a `financials?.ownerPayoutCents` field that doesn't exist on `FinancialBreakdown` (harmless fallback, but dead/wrong code).
- `calculateSimplifiedRefund` (the "new" Phase-4 refund policy) is exported but only ever called by its own unit test.
- **Live money-movement bug**: contracts show agents entitled to 30% of platform commission; the only code path that actually persists `booking.financialBreakdown` hardcodes 0% — every real payout pays the agent nothing from commission while the signed contract promises 30%.
- Insurance is entirely a stub provider (`StubInsuranceProvider`) — fabricated premiums, hardcoded coverage, no real underwriter, explicitly a placeholder for a future Tint SmartSTR partnership.
- Claims that exceed the deposit, or get disputed/escalated, are promised "escalation to the insurance provider" in the UI — this is never implemented; `resolveClaim` is the only resolution path and it's deposit-capped.
- No admin UI exists for claim resolution — only reachable via a raw REST endpoint with no frontend page.

### 4. Agents, Agencies & Reputation
- **Critical**: the entire `AgentApplication` vetting workflow is disconnected from platform access — `PENDING`/`REJECTED`/no-application agents all get full agent-portal access identically to `APPROVED` ones; only `REVOKED` blocks anything.
- No way to lock out a `REJECTED` applicant — admin's Revoke button only appears for `APPROVED` applications.
- "Deactivate sub-agent" doesn't revoke portal access despite the confirmation dialog claiming it does.
- Insurance/license docs are effectively optional (schema marks them `.optional()`, no validation gate) and admins have no way to view an uploaded document, only a checkmark.
- `UNDER_REVIEW` application status is unreachable — modeled everywhere, set nowhere.
- No reapplication flow after rejection.
- `AgencyMemberRole.ADMIN` is schema-only and never checked.
- `AgencyInvite.expiresAt`/`EXPIRED` are never set/checked — invites never expire.
- `setCommissionSplitSchema` is dead code; sub-agent split has no dedicated endpoint or authorization check.
- `reassignBookings` server action lacks ownership verification on `fromAgentId`/`toAgentId` (the only UI path that uses it does check correctly; the standalone action doesn't).
- "View Bookings" per-sub-agent link is broken (wrong route, and the filter it implies doesn't exist).
- Team page mislabels solo agents as "part of a team."
- Agent tier feature gates (`maxSubAgents`, branded checkout) are declared but never enforced anywhere.
- `AgentBrand.customDomain`/`customDomainVerified` are schema-only, no UI/DNS/tier gate.
- Revoking a main agent has no cascading effect on their sub-agents.
- Guest-flag reputation lookups are retrospective-only — never checked at booking-creation time.

### 5. Messaging, Notifications & Push
- `BOOKING_HOLD_WARNING` notification type has full plumbing (enum, template, preference) but is never triggered.
- `SUB_AGENT_BOOKING`, `SUB_AGENT_JOINED`, `SELECTION_UPDATED` notification types are never triggered — dead enum values.
- `src/emails/availability-request.tsx` is an orphan component, never imported.
- `message/thread-created` event has zero subscribers — starting a conversation notifies nobody.
- Real DB-backed message search (`searchMessages`) is fully built but unreachable — the Inbox UI only does client-side filtering of already-loaded previews.
- `getOrCreateThread` action exists for a "Message Owner" button that doesn't exist anywhere in the UI.
- Notification preferences UI only covers 10 of 39 `NotificationType` values — the other 29 (contracts, payments, subscriptions, claims/deposits, selections) have no settings-screen control.
- Notification icons only special-case 3 prefixes; all later-phase types render a generic Calendar icon.
- `archiveThread` action has no thread-membership authorization check, unlike every sibling messaging action.
- Duplicate payment notifications: the same `booking/paid` event fires two separate owner notification rows from two overlapping types.
- `pushService.hasSubscription` has no caller; `subscribeExpo` is only reachable via REST, not a server action (expected given Expo-only-from-native, but asymmetric).
- `MessageThread.bookingId` is nullable in schema ("general inquiries") but no code path ever creates a booking-less thread.

### 6. Collections, Selections & Clients
- No agent-facing "Clients" page exists at all — only owners/admins can view `ClientProfile`.
- `Client.notes` is dead schema — never set, never read, never rendered.
- `SelectionBookingRequest` has no agent review UI or action anywhere — a client's booking request off a selection goes nowhere actionable today; this is the single biggest gap in that flow.
- Likely bug: favorite notifications read "undefined favorited [property]" because the Inngest event omits `clientName` while the handler expects it.
- `AgentBrand.customDomain`/`customDomainVerified` are schema-only, unused (duplicate of the Agents-section finding).
- Villa reordering within a Selection is append-only — no drag-to-reorder UI or action.
- PDF generation completion is polled blindly via a flat 5s `setTimeout`, no real completion signal.
- Cover-image upload has a client/server file-size limit mismatch (5MB vs 10MB) — sloppy, not exploitable.

### 7. Admin, Auth & Infrastructure
- `apiLimiter` (60 req/min) is defined but never used anywhere — the entire authenticated `/api/v1/*` surface is unthrottled.
- Rate limiting is silently disabled by default — Upstash env vars aren't in `.env.example` or the validated env schema, so a fresh deploy runs with zero rate limiting anywhere, with no warning.
- `ROLES` fine-grained permission map is fully dead code — never consumed; all real gating uses the coarse 3-value role enum.
- `PropertyStatus.SUSPENDED` has no transition path anywhere (duplicate of the Listings-section finding).
- Agent application status transitions have no service-layer state-machine guard (contrast with Property review, which does enforce it) — only client UI prevents illegal transitions.
- `ApplicationStatus.UNDER_REVIEW` unreachable (duplicate of the Agents-section finding).
- Admin "concierge" owner selector (create-listing-on-behalf-of) is fully built backend with zero UI consumers anywhere.
- Platform-wide revenue/summary stats are fully implemented but deliberately not surfaced in the web admin dashboard — no revenue view exists in-app.
- No trust & safety moderation surface for admins — guest flags/ratings are fully peer-to-peer with no admin visibility or override.
- `guards.test.ts` is a placeholder stub with a TODO list, not a real test.
- No automated tests for `middleware.ts`, rate limiting, or R2 storage modules.
- Presigned upload endpoint has no resource-ownership check, and the client-declared file size isn't enforced server-side at PUT time.

### 8. Background Jobs & Email
- `team/invite-sent`/`team/invite-accepted` events have no Inngest handler — invited sub-agents never receive an invitation email.
- `PaymentLinkEmail` is fully built and wired, but its only intended caller never actually calls it — the client never receives the payment-link email the docstring promises.
- `BookingHoldWarningEmail`, `BookingConfirmedEmail`, and `ContractAllSignedEmail` are all fully built and mapped but never sent by their corresponding jobs (in-app only).
- **Highest-impact gap**: `BalanceDueReminderEmail` is fully built with overdue-styled variants, but the flow that auto-cancels a booking and refunds a deposit (day-1/3/5 reminders + day-6 auto-cancel) never emails anyone about it — in-app only, despite the template defaulting to `emailEnabled: true`.
- `availability-request.tsx` and `selection-updated.tsx` are orphan email components, never wired to any sender.
- A broad, consistently-documented pattern: every claim/deposit/rating/pre-stay/subscription/contract-reminder notification type defaults to `emailEnabled: true` but has no email template at all — in-app-only "for now" across the board.
- Insurance is entirely synthetic (duplicate of the Payments-section finding, from the job-pipeline side).
- Stripe Connect payout failures have no retry/reconciliation job — a one-shot check tied only to `booking/confirmed`.
- `selectionConfirmationReminders`'s "owner unresponsive" notice is purely informational — never auto-removes the villa or stops further reminders.

### 9. API Routes
- `apiLimiter` unused across the entire `/api/v1/*` surface (duplicate of the Infrastructure-section finding, from the route-count perspective — confirmed against ~80 routes).
- Stripe subscription webhook cases are empty no-ops — the intended consumer job is never triggered (duplicate of the Billing-section finding, confirmed at the route level).
- **Security issue**: `PATCH /api/v1/auth/profile` lets any authenticated user self-escalate their own role to `ADMIN` with zero additional checks.
- Systemic missing ownership checks across contracts/payments/deposits/listings-read/clients-read routes: any authenticated user can generate/void/download another user's contract, create payments/deposits against arbitrary booking IDs, read draft listings, or read any client's profile.
- `/api/v1/connect/onboard`'s Stripe return URL points at a callback route that doesn't exist — the mobile Stripe Connect onboarding flow redirects to a 404 after completion.
- No DELETE route exists for iCal feeds, despite the service method being fully implemented.
- Three routes lack the dual cookie/Bearer auth pattern used everywhere else (`/api/upload/presign`, `/api/notifications/unread-count`, `/api/selections/villa/[id]/confirm`) — would block a Bearer-only mobile client.
- Checkout-token validation logic is duplicated independently in two places (legacy web route and v1 mobile route).

### 10. Mobile-Responsive Web & PWA
- Bottom-nav unread badge counts are fully implemented but never actually populated — no layout passes the `badgeCount` prop.
- `DataTableEmpty`'s `isFiltered` prop is computed and passed but silently dropped by the component's own destructuring — mobile empty states can't distinguish "no results due to filters" from "genuinely empty."
- Manifest icon set is minimal (only 2 source PNGs, no dedicated maskable safe-zone asset, no screenshots array).
- Service worker does no offline caching — explicit and intentional, but means no offline page/resilience.

### 11. Mobile App — Expo Rewrite
- Admin settings screen is a literal 11-line static placeholder with no functionality, not even sign-out.
- **Sign-out is unreachable from the UI anywhere in the app** — the working `signOut()` function exists but every settings screen binds the row to a no-op.
- "Privacy & Security" rows are no-ops in both agent and owner settings.
- New-user onboarding has a genuine dead end: the default `onboarding/index.tsx` route is a static, non-interactive stub with no navigation to the real, fully-built role-picker screen at `onboarding/role.tsx`.
- Agent-dashboard "commission earned" stat is hardcoded to `"Coming soon"` — explicitly unimplemented.
- Five UI components (~520 lines) are exported from the barrel but never imported by any screen — dead code.
- `ContractSection`'s sign action hardcodes `signerRole: "agent"` even when reused on the owner's booking screen — relies on an unverified comment that the server ignores the client-supplied role.
- Map search has no viewport-bounds wiring — panning/zooming never refetches a scoped marker set.
- Only 3 test files exist in the entire mobile app (API client, secure store, auth provider) — no component/screen tests.

### Testing coverage gaps (cross-cutting)

- **Module coverage matrix**: of 20 business modules, only 3 have any unit tests — `bookings`, `messaging`, `payments`. The other 17 (`admin`, `agents`, `billing`, `calendar`, `claims`, `clients`, `collections`, `contracts`, `deposits`, `insurance`, `listings`, `notifications`, `push`, `reputation`, `search`, `selections`, `teams`) have zero automated tests — including contract signing (DocuSign), deposits, insurance, claims/disputes, billing/Stripe subscriptions, listings CRUD, search, and calendar/availability.
- All existing unit tests run against fully mocked Prisma/Inngest — none exercise a real database round-trip.
- **E2E coverage is minimal**: 5 total test cases across 2 spec files, verifying only login-redirect and role-based dashboard routing. No E2E test creates a listing, requests/approves a booking, signs a contract, makes a payment, sends a message, or manages availability — despite 517 lines of unused, well-built Page Object Models and 8 unused data factories sitting ready for exactly this.
- **The E2E CI job is effectively disabled**: gated on a repo variable plus three Supabase secrets that, per the project's own phase notes, are not configured — the 5 E2E tests that do exist have likely never run in CI.
- `src/shared/auth/guards.test.ts` is a placeholder (`expect(true).toBe(true)`) — the dual-mode auth logic it's meant to cover has no real test.
- Adapter tests (Stripe/DocuSign/Inngest/R2/Resend fakes) and the factory integration test exist but are orphaned from CI — real npm scripts exist but nothing calls them automatically.
- `apps/mobile` has no CI test gate at all — excluded from the workflow and from lint scope entirely.
- No coverage threshold or reporting anywhere — `test:coverage` exists as a script but CI never runs it.
- `phases-19-20-audit.test.ts` verifies source-code text patterns via regex, not runtime behavior — brittle to refactors, and covers none of the 17 untested business modules.
- `src/test/prisma-mock.ts`, a shared deep-Prisma-mock helper, is dead scaffolding — no test file actually imports it.

**Bottom line**: booking state transitions, booking approval/hold permission rules, messaging thread/message/attachment rules, and the financial calculator (markup, commission, deposit/balance split, refund-policy tiers) are the only parts of the app with real automated verification. Everything involving DocuSign contracts, security deposits, insurance, damage claims, Stripe subscriptions/billing, listings CRUD, search, calendar/availability, admin tooling, agent vetting, collections, reputation, and team management is built but currently unverified by any automated test — and several of those areas (security deposit charge confirmation, instant-book deposit creation, agent commission persistence, subscription webhook sync) contain live, confirmed bugs that this lack of coverage let ship unnoticed.
