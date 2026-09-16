# ClubHedge

A private, play-money prediction market for club recruiting season. Friends bet virtual chips
on two questions per candidate × club pair: *do they get an interview?* and *do they get in?*

No real money. No payments. No server. Just chips and consequences in the group chat.

## Running it

Open `index.html` in a browser. That's it — three files, no build step, no dependencies, no
network calls. It works offline permanently after the first load, and you can host it anywhere
static (GitHub Pages, Netlify drop, a USB stick) if you'd rather have a URL.

```
index.html   markup + shell
styles.css   the whole look
app.js       data model, market logic, settlement, views
```

## How a group actually uses this

There is no backend, so **one person runs the house** and the exported JSON file is the group's
source of truth. The loop:

1. **House creates the pool** — Pool tab → name it (“Fall 2026 Recruiting”) → Create.
2. **House does setup** — Setup tab → add clubs, candidates, and one bettor per friend.
   Everyone starts with 1000 chips. Tune the payout multiplier and cancel fee here too.
3. **House exports** — Pool tab → Export JSON → drop the file in the group chat.
4. **Everyone imports** — Pool tab → Import JSON → pick the file. Set "Betting as *you*" in the
   Board toolbar, place your bets, then Export and send your file back to the house.
5. **House merges by hand** — the honest version is: the house imports each person's file in
   turn only if nobody else has bet since, or (simpler and what most groups do) everyone places
   bets on the house's device / screen share during a betting window.
   Then: **House locks the pool** (Setup → Lock pool) once betting closes.
6. **Results come in** — House tab → mark Interview and Acceptance as yes/no. Every open bet on
   that leg settles instantly and balances update. Marked something wrong? Set it back to `?`
   and the settlement unwinds.
7. **Standings tab** — live leaderboard and an activity feed of every chip that moved.

> The sync story is deliberately dumb: whoever holds the newest JSON holds the truth. Export
> after anything important. If two people bet on two different copies, one copy loses.

## Rules as shipped

| Rule | Default | Where to change |
|---|---|---|
| Starting stack | 1000 chips | Setup → House rules |
| Payout | 1.9× (a winning 100 returns 190) | Setup → House rules |
| Cancel/edit fee | 5% of stake | Setup → House rules |
| Interview vs. acceptance | independent markets | — |
| Max stake | none, go all in | — |

Interview and acceptance settle **separately**: a "no" on interview does not auto-settle the
acceptance market, so the house has to mark both. Pulling a bet before settlement refunds your
stake minus the fee — hedging costs something, which is the point.

## Data model

Everything is one JSON object (also exactly what gets exported):

```js
Pool {
  id, name, createdAt, schemaVersion,
  settings:   { startingChips, payout, cancelFeePct, locked },
  clubs:      [{ id, name, note }],
  candidates: [{ id, name, year, school }],
  bettors:    [{ id, name }],
  markets:    [{ id, candidateId, clubId,
                 interview:  { result: 'pending'|'yes'|'no' },
                 acceptance: { result: 'pending'|'yes'|'no' } }],
  bets:       [{ id, marketId, bettorId, leg, side, stake, payout, status, createdAt, settledAt }],
  ledger:     [{ id, ts, bettorId, type, amount, betId, note }]
}
```

The **ledger is the source of truth for chips** — a balance is always `sum(amount)` over a
bettor's entries, never a stored number that can drift. Entry types: `seed` (starting stack),
`stake` (chips locked into a bet), `refund` + `fee` (cancellation), `payout` (winning bet,
stake included), `loss` (zero-value, kept so the feed reads honestly). That also means P&L
history and the activity feed are free — they're just views over the ledger.

Markets are created **lazily**: a candidate × club pair only becomes a row once someone bets on
it or the house rules on it, so adding 10 candidates × 5 clubs doesn't create 50 dead objects.

## Storage

State is saved to `localStorage` under `clubhedge.pool.v1` on every change. Clearing site data
deletes your pool — **export first**. Import validates and fills in missing fields, so old
exports keep working as the schema grows.
