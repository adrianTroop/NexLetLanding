# NexLet — Product Spec (sourced from the real app, not this repo)

This repo (`NexLetLanding`) is only the marketing waitlist page. The actual product lives in a separate repo, **`villaAgentBooking`** (local: `~/Coding/villaAgentBooking`, GitHub: `adrianTroop/villaAgentBooking`, npm package name `nexlet`). This doc describes that real app so landing-page copy can be brought back in line with what's actually built.

## What NexLet is
A **B2B luxury villa rental marketplace** connecting property owners with vetted booking agents. Owners list a villa and the platform handles the rest — contracts, payments, insurance, and agent vetting — so they don't manage bookings manually.

**Core workflow:** agent searches → requests booking → owner approves (or instant-book bypasses approval) → contract generated & signed (DocuSign) → payment collected (Stripe) → booking confirmed → managed through to completion.

**Roles:** Agent, Owner, Admin (plus Agency/team structure — agents can belong to an agency with invites and member roles).

## Status
- **v1.0** (core marketplace) — shipped 2026-02-24, 13 phases, 58 plans
- **v1.1** (mobile-responsive web experience) — shipped 2026-03-16, 7 phases
- **v1.2** (E2E test coverage, Playwright) — in progress: phases 21-22 done, phase 23 (account/listing/search tests) next, 24-25 pending
- **Mobile rewrite** — active, separate effort (see below), substantial screens already built, not yet shipped

## Feature surface (by module — `src/modules/`)
- **listings** — property CRUD, photos, amenities, pricing, availability calendar
- **bookings** — request → approve → sign → pay → confirm → complete lifecycle, instant-book mode
- **contracts** — DocuSign integration, contract status tracking
- **payments** — Stripe checkout, payment splits, owner commissions, payouts
- **deposits** — security deposits
- **insurance** / **claims** — insurance policies, claim filing with evidence attachments
- **calendar** — iCal feed sync (import external calendars), conflict detection
- **messaging** — real-time threads (agent ↔ owner) via SSE, file attachments
- **collections** / **selections** — agents curate villa shortlists into branded client proposals (exportable), with client-facing views, favorites, view tracking, and booking requests off a selection
- **agents** — application & vetting workflow, agent tiers, subscriptions, agencies/teams (invites, member roles)
- **reputation** — ratings/reviews
- **notifications** / **push** — in-app + web push, per-user preferences
- **admin** — dashboard, agent application approval, trust & safety flags
- **billing** — agent subscriptions

~7,500 lines of TypeScript, 20 business modules, 21 background jobs (Inngest), 41 Prisma models.

## Data model (Prisma/Postgres — key entities)
`Property`, `PropertyPhoto`, `PropertyAmenity`, `Season` (dynamic seasonal pricing), `ExtraFee`, `CancellationPolicy`, `CalendarDay`, `ICalFeed`/`ICalConflict`, `Booking`, `Contract`, `Payment`/`PaymentSplit`/`Payout`/`OwnerCommission`, `SecurityDeposit`, `InsurancePolicy`, `Claim`/`ClaimEvidence`, `AgentApplication`, `Agency`/`AgencyMember`/`AgencyInvite`, `AgentBrand`, `AgentSubscription`, `Selection`/`SelectionVilla`/`SelectionFavorite`/`SelectionView`/`SelectionBookingRequest`, `Collection`/`CollectionItem`, `Client` (agent's end customer), `Message`/`MessageThread`/`MessageAttachment`, `Rating`, `Notification`/`NotificationPreference`/`PushSubscription`, `UserProfile`, `StaffService`, `GuestFlag`.

## Tech stack (web — the production app)
Next.js 16 (App Router, server actions), Prisma + Postgres, Supabase (auth), Stripe, DocuSign (`docusign-esign`), Resend (email), Inngest (background jobs), Cloudflare R2 (file storage via `@aws-sdk/client-s3` presigned uploads), Sentry, Upstash (rate limiting), shadcn/ui + Tailwind CSS 4, React Hook Form + Zod, TanStack Query, Zustand, PWA (installable, web push).

## Mobile — Expo universal rewrite (in progress)
Separate active initiative (`apps/mobile/` inside the same repo, tracked in `.planning/`): converting the web app into an **Expo Router universal app** (iOS, Android, Web) with **full feature parity**, keeping the Next.js app as the API backend (server actions are being converted to REST endpoints the mobile app consumes). Stack: Expo SDK 54, NativeWind v4.1, gluestack-ui v3 ("shadcn for React Native"), Supabase React Native SDK for auth, `@stripe/stripe-react-native` for payments, `react-native-maps`. Deployment target: Railway (API) + EAS Build (native apps). Screens already scaffolded for all three roles (owner/agent/admin) — dashboard, properties, bookings, messages, settings, search, clients, collections. This is very likely what corresponds to the `NextLetMobile` GitHub repo.

## Known open items (from the app's own planning docs)
- v1.2 E2E suite incomplete — booking/payment/contract flows and messaging/admin/mobile flows not yet covered by automated tests
- Legal counsel still needed for PSD2/PDS/IDD compliance (payments + insurance regulatory exposure) — flagged as outstanding since v1.0
- Some deferred code-quality findings: selection-actions consistency, duplicate pricing logic, contracts service decomposition
- Mobile rewrite has no fixed completion date in the plans reviewed

## How this connects back to the landing page
The current landing copy (`ForWho.tsx`, `HowItWorks.tsx`, `ValueProps.tsx` in this repo) already matches the real product's basic framing (owner control + agent verification) but undersells what's actually built — no mention of contracts, insurance/claims, payments/payouts, agencies, or agent-curated client proposals (Selections), all of which are real, shipped features. It also references a `waitlist` Supabase table that doesn't exist in the Supabase project this repo is currently wired to (that project belongs to an unrelated business) — the signup form is effectively broken right now.
