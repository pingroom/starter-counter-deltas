# Counter deltas with PingRoom

Turn ordered modular counter readings into exact interval increments. A named operator supplies documented wrap or reset evidence through PingRoom. Code calculates increments and interval average rates while retaining gaps and contradictions.

The paper-card example covers a wrap, ordinary increments and two further wraps. The offline demo also shows a reset, inconsistent evidence and Unknown. It performs no billing, device changes or deployments.

## Run offline

Use Node.js 22 or newer and npm. Choose **Use this template**, clone your copy, then run:

```sh
npm ci
npm test
npm run demo
```

Tests and demo exercise the pinned `@pingroom/sdk` through local mock transports. After installation they need no network, credentials, account or phone. The lockfile is committed; `.npmrc` requests a 14-day minimum release age where supported by npm.

## Define the readings

```sh
cp examples/model.json model.json
cp config.example.json config.json
npm run validate
```

Edit `model.json` before starting:

- `counterId`: at most 32 characters, starting with a lowercase letter and using lowercase letters, digits, `_` or `-`.
- `title`: 32 characters; `context`: 60; `meaning`: 40; `unit`: 16. Describe the counter and what one increment measures.
- `modulus`: integer 2–1000000000. A continuous counter rolls from `modulus - 1` to zero.
- `readings`: 2–8 records, each containing only `at` and `value`. Values are integers from zero through `modulus - 1`.

Timestamps must be strictly increasing UTC date-times with seconds and optionally 1–3 fractional digits, ending in `Z` or `+00:00`. They normalize to milliseconds. Submillisecond precision, invalid dates and duplicate times are rejected; readings are never sorted. For example, `2026-11-09T09:00:00Z` and `2026-11-09T09:00:00.000+00:00` represent the same instant.

Text limits use UTF-16 code units. Extra fields, negative zero, fractional numeric values, malformed Unicode, control/format characters, line breaks and surrounding whitespace are rejected. Every complete interval prompt must fit 500 characters.

## Connect and collect evidence

Install [PingRoom](https://pingroom.io/i), create a private standard room containing the operator, then run:

```sh
npm run connect
npm run inspect
```

Open the printed pairing link, approve the connection and grant the room. Verify the person in the app, then enter their exact member UUID and descriptive label in `config.json`; a name alone is insufficient. For an existing granted connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and the 12-character `PINGROOM_ROOM`. Partial pairs are rejected.

```sh
npm start
```

Each invocation creates at most one direct, 15-minute Question or reads the existing one. After the operator answers, run it to record the response, then again for the next interval. There are at most seven Questions; each includes the counter meaning, context, unit, modulus, both timestamps and both readings.

For each adjacent interval, reply with exactly one of:

- **0**, **1**, **2** or **3**: the documented number of full modulus crossings over that exact interval, with no reset during it.
- **Reset**: any reset occurred, regardless of other wraps or the endpoint readings. Reset takes precedence.
- **Unknown**: the required evidence is unavailable, including a crossing count outside the supported range.

Never infer a wrap count from a decrease alone. Increasing or identical readings can include wraps. Numeric replies accept no signs, spaces or leading zeros. Validation checks returned API text and cannot detect whitespace trimmed by the server.

Every interval requires a known response. Unknown, missing, expired, cancelled, invalid or misattributed answers withhold the entire analysis. Evidence remains bound to the original request, operator, room, asking registration, timestamps and calculation policy.

## Inspect and export

```sh
npm run status
npm run report
npm run export-analysis
npm run export-total
```

These commands are local. `report` writes `.counter/report.json`. `export-analysis` writes `.counter/analysis.json` when all evidence is known, including resets and contradictions. `export-total` writes `.counter/total.json` only when every interval is continuous and consistent. Resets and contradictions are complete findings; Unknown leaves evidence incomplete.

For a numeric response, code computes with BigInt:

```text
delta = nextValue - previousValue + wraps × modulus
interval average rate = (delta × 1000) / elapsedMilliseconds
```

Zero is valid. A negative result records `inconsistent` with `signedComputedDelta`; usable delta and rate are null. Reset intervals also have null delta and rate: lost usage and usage after reset within that interval are never inferred.

Within `analysis`, `knownSubtotal` sums only the listed continuous, consistent intervals. It is not total usage when coverage is partial. `coverage` lists included, reset and inconsistent interval IDs, counts and covered elapsed milliseconds. `exactTotal` and `exactRatePerSecond` stay null unless coverage is complete. Rates are interval averages, never instantaneous rates; ratios use unreduced decimal-string numerators and denominators. The example's responses `1`, `0`, `2` yield increments `20`, `25`, `205` and exact total `250` cards.

[RFC 2578 §7.1.6](https://www.rfc-editor.org/rfc/rfc2578.html#section-7.1.6) describes wrapping counters and discontinuities. This template uses a generic bounded modulus and does not implement SNMP Counter32/64. It assumes monotonic increments between resets and exact readings, times and reported crossings; it cannot verify event records or device behaviour. To adapt it, map your readings into this schema and choose an operator with suitable records. Interpolation, missing-interval estimation and billing integration are outside its scope.

## Resume safely

Root inputs, credentials, state and exports are ignored by Git. Keep `.counter/` and `.pingroom/` private and intact. Changed readings, meanings, units, modulus, identity or credentials cannot reuse a session. Input/config limits are 64/16 KiB; writes are atomic under a local lock.

A lost creation response leaves `create_unknown` and is never automatically resent:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. No match in the bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending file. Remove a stale `.lock` only after confirming its process stopped. Resolve the original session before archiving it for revised inputs; never delete state to retry.

Run commands serially. Exit codes: `0` complete/local result, including complete reset or inconsistent analysis; `1` invalid setup/evidence or refused export; `2` incomplete/failed answer; `3` pending/ready/interrupted; `4` uncertain creation.

Tests cover independent increment simulations, boundaries, SDK/CLI recovery and private exports. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
