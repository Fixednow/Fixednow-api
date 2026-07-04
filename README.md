# FixedNow Matching API

Implements the geo-matching + broadcast cascade from the plan: nearest-provider
lookup, ping-with-countdown, decline-cascades-to-next, and real-time location
streaming.

## How the flow works

1. Customer `POST /jobs` with category + location → job is created and
   `broadcastJob()` pings the closest `PARALLEL_PING_COUNT` (default 3)
   online, verified providers **simultaneously** — a "round."
2. All pinged providers get a `job:offer` WebSocket event with a 20s
   countdown (`OFFER_TIMEOUT_SECONDS` in `matchingService.js`).
3. Provider calls `POST /jobs/:jobId/offers/:offerId/accept` or `/decline`.
   - Accept → job locked in, every other pending offer in the round is
     cancelled, the customer is notified, and the losing providers get a
     `job:offerCancelled` event so their UI clears immediately instead of
     waiting out the countdown.
   - Decline → marked, but the *next* round only starts once the whole
     round is resolved (see `maybeAdvanceRound`) — one early decline
     doesn't cut short someone else's countdown.
4. If providers just don't respond, `offerExpiryWorker.js` polls every 3s,
   expires overdue offers, and once a full round has resolved with no
   acceptance, starts the next round automatically.
5. While online, providers stream location over the `provider:location`
   socket event; the server only writes to Postgres if they've moved more
   than 10m (battery/bandwidth optimization from the brief), and relays the
   position live to any customer tracking an active job with them.

## Setup

```bash
cp .env.example .env   # point DATABASE_URL at your Postgres+PostGIS instance
npm install
# apply schema.sql, then seed.sql, to your database (psql -f ...)
npm run dev
```

Requires the `schema.sql` and `seed.sql` from the previous steps to be
applied first. `seed.sql` gives you one online urgent-switch provider
(Mechanic/Tyre Fitter/Roadside Assistance/Handyman near Rathmines, Dublin)
and one book-switch provider (Cake Maker, with two completed+reviewed jobs)
— without it, every request in the customer app resolves to "no providers
found" on a fresh database.

CORS is wide open (`app.use(cors())`) so the customer/provider apps can call
this API directly from a browser regardless of origin. Restrict it to your
real frontend domain(s) before this goes near production.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/categories` | List active service categories (id, name, flow_type, timeouts, etc.) |
| POST | `/customers` | Minimal customer creation — stands in for real auth, which doesn't exist yet |
| POST | `/jobs` | Create a job, triggers first broadcast |
| POST | `/jobs/:jobId/offers/:offerId/accept` | Provider accepts |
| POST | `/jobs/:jobId/offers/:offerId/decline` | Provider declines, cascades |
| POST | `/jobs/:jobId/status` | Provider advances to `en_route` / `arrived` / `in_progress` |
| POST | `/jobs/:jobId/complete` | Provider marks complete — requires `photoUrls` if the category's `requires_completion_photo` is set |
| POST | `/jobs/:jobId/review` | Customer rates a completed job — rolls into the provider's `rating_avg` |
| GET | `/jobs/:jobId` | Poll job status |
| GET | `/providers` | Public: browse list ranked by Bayesian-weighted rating. Optional `?categoryId=`, defaults to portfolio categories |
| GET | `/providers/:providerId/portfolio` | Public: provider's rating + gallery of completed-job photos (only jobs marked public) |

## Ranking: why not just sort by rating_avg

`GET /providers` ranks by a Bayesian-weighted score, not raw `rating_avg` —
otherwise a provider with a single 5-star review outranks one with 200
reviews averaging 4.8. The formula (IMDB-style):

```
weighted = (v / (v + m)) * R + (m / (v + m)) * C
```

- `R` — the provider's own average rating
- `v` — their review count
- `C` — the platform-wide mean rating (computed from all active providers)
- `m` — `MIN_VOTES_FOR_CONFIDENCE` in `providers.js` (currently 10)

A provider with `v >> m` ranks close to their own average; a provider with
few reviews gets pulled toward the platform mean until they've earned
enough of a track record to be trusted on their own numbers.

## Completion photos: proof-of-work vs public portfolio

These are two separate concerns on the same photos:

- **`requires_completion_photo`** (category-level) — must the provider attach
  a photo to mark the job complete at all? On by default everywhere; it's
  the proof-of-work record for payout/quality disputes.
- **`completion_photos_public`** (per-job) — should those same photos be
  shown on the provider's public portfolio for other customers to browse?
  Defaults from the category's `portfolio_category` flag: **on** for the
  scheduled/quote categories (Cake Maker, Florist, Balloon Maker, Bouncy
  Castle Hire, Landscaper, Dog Groomer) where customers pick a provider
  partly on past work, **off** for on-demand categories (House Cleaner,
  Roadside Assistance...) where a completion photo might show the inside of
  someone's home or car and shouldn't default to public. The customer can
  override this per job via `photosPublic` in the `POST /jobs` body.

## Not yet built (next steps)

- Auth/JWT middleware (routes currently trust `providerId`/`customerId` in the body)
- Payment capture on job completion (Stripe PaymentIntent flow)
- Push notifications (FCM/APNs) as a fallback when the socket is disconnected
- Rate limiting on the location-update endpoint
