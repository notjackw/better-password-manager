# How login pages are built: 52 sites

Sites were picked from your saved-passwords list for variety: big tech, shopping, streaming, banks,
travel, school, government and job sites. `scripts/survey.mjs` opened each login page in a test copy of
Chrome, waited for it to load, and ran the extension's detection on every frame. **It never typed or
submitted anything**, so only the first screen of each login was seen.

Date: 2026-10-24.

## Summary

| Type | Sites | What makes it hard |
| --- | --- | --- |
| 1. Classic: email and password on one page | 22 | Nothing much. Every password manager handles these. |
| 2. Email first, password on the next screen | 17 | The email and password are never on screen together. |
| 3. Login inside a frame | 3 (+ ESPN) | The fields live in an embedded page, sometimes from another site. |
| 4. Couldn't check (bot protection, broken URL, or OpenAI's button-only page) | 10 | Not a page type. These sites block automated browsers, so they need a manual check. |

The extension recognized the first screen correctly on every site that loaded. One bug turned up and is
fixed (Airbnb, see below).

## 1. Classic: email and password on one page

**GitHub, Facebook, Instagram, LinkedIn, Discord, Twitch, Netflix, Peacock, Paramount+, American Express,
Wells Fargo, Fidelity, Robinhood, Delta, Marriott, Workday (Boeing jobs), Login.gov, USPS, Starbucks,
LeetCode, Quizlet, Georgia Tech**

This is the old-fashioned layout: one form with both boxes. Variations seen:

- **No `<form>` at all.** LinkedIn's boxes sit in plain containers. The extension groups them by the
  nearest container that holds a password box and a button.
- **Login hosted on a separate address.** Starbucks sends you to `auth.starbucks.com` (run by Auth0),
  USPS to `verified.usps.com`, Georgia Tech to `sso.gatech.edu`, a university single sign-on system (CAS).
  It's still the same website, so the login is filed under the right site.
- **Web components.** GitHub and Robinhood use shadow DOM (a hidden inner layer of the page). The extension
  searches inside it, and the login fields were found.
- **`autocomplete="off"` on the password.** Seen on Wells Fargo, Fidelity, Marriott, Paramount+ and
  Georgia Tech. It's meant to block password managers. The extension ignores it.

## 2. Email first, password on the next screen

**Google, Microsoft, Yahoo, X, Dropbox, Zoom, Amazon, Walmart, Target, Nike, Home Depot, Disney+, Hulu,
Spotify, Coinbase, Ticketmaster, Airbnb** (plus MLB and ESPN from earlier testing)

This is the most common modern layout, and the one built-in password managers miss most. You type your
email and click Continue. The page then shows a password box, often without loading a new page.

- **Several sites move you to a new address for step 1.** Nike goes to `accounts.nike.com/lookup`,
  Disney+ to `/identity/login/enter-email`, and Hulu to `auth.hulu.com/.../enter-email`.
- **"Log in or sign up" on one screen.** Airbnb and Amazon ask for your email before deciding whether you're new. The
  next screen is a login or a signup depending on the answer, which is why both are tracked.
- **The password screen may never come.** X, Spotify, Airbnb and Coinbase often send a code or offer a
  passkey instead. Then there's no password to save, and that's expected.
- **Airbnb bug, fixed.** Airbnb keeps its email box transparent until you click it. The extension
  treated transparent boxes as hidden and found nothing on the page. Transparency no longer counts as
  hidden (`src/content/fields.js`).

**Not verified:** step 2 on these sites. Seeing it would mean submitting a real email.

## 3. Login inside a frame

**Apple, Chase, Schwab** (and ESPN)

The page you see is only a shell. The login box is a separate page embedded in it (an iframe).

- **Apple:** `account.apple.com` embeds the login from `idmsa.apple.com`. It's the same company but a
  different address.
- **Chase:** embeds a login page from its own address.
- **Schwab:** embeds `sws-gateway-nr.schwab.com`, again a different address on the same site.
- **ESPN** is the hard case: the frame comes from a *different site* (`registerdisney.go.com`).

The extension runs inside every frame, so all of these were detected.

## 4. Couldn't load in a test browser

| Site | What happened |
| --- | --- |
| GitLab | Cloudflare bot check (403) |
| eBay | Blocked (403) |
| Chewy | "Too many requests" (429) |
| PayPal, Venmo, NYTimes | DataDome bot check (403) |
| Reddit | "Prove your humanity" page |
| Canvas | Server error (503) |
| Taleo (EY) | The address no longer exists |

OpenAI loaded, but its page shows only a "Log in" button, so there was nothing to check yet.

These sites block automated browsers, not people. Please test them by hand with **Highlight detected
fields** turned on.

## What this means for the extension

1. **Type 2 is the priority.** It covers 17 of the 43 sites that loaded, and it's where Chrome, Apple
   and Bitwarden fall down. The extension remembers the email from step 1, but step 2 hasn't been
   checked on these real sites.
2. **Code-only and passkey logins** (X, Spotify, Airbnb, Coinbase) have no password to save. The
   extension should leave them alone, which it does.
3. **Frames are covered**, including ESPN's frame from another site.

## Rerun it

```sh
node scripts/survey.mjs research          # writes research/survey.json and screenshots
ONLY='airbnb' node scripts/survey.mjs     # one site
```

## Full scan: all 454 sites in your list

The same check, run on the address saved for every site in `passwords.csv`. Many saved addresses are a
homepage rather than a login page, so a lot of sites showed no login at all.

| Result | Sites | Notes |
| --- | --- | --- |
| Couldn't load | 120 | Bot checks (403/429), dead addresses (old school and job sites), timeouts |
| No login on screen | 197 | Homepages, "session expired" pages, redirects. Spot checks confirmed nothing was missed. |
| Email box, but not a login | 34 | Newsletter sign-ups, "reset your password" forms. Correctly left unlabeled. |
| Classic: email and password together | 57 | Citi, Ally, Capital One, TD Bank, Login.gov, Facebook, Instagram… |
| Email first, password next | 36 | Google, Gmail, Spotify, Uber, Coinbase, DocuSign, TurboTax, Indeed, Wix… |
| Login inside a frame | 10 | Chase (6 addresses), Schwab (2), SoundCloud, Vista |

Of the 103 real login pages that loaded, **35% ask for the email first** and **10% sit inside a frame**.

**Minor quirk:** the GitHub and Netflix homepages have a "Sign up with your email" box that the extension
labels as login step 1. That's harmless: it just remembers the email you typed, which is the right email.

## Step 2: what comes after the email screen (42 sites)

`scripts/email-step.mjs` typed the username saved for each site into its email screen and pressed Enter.
It never typed a password.

| Next screen | Sites |
| --- | --- |
| Password box | 10: Atrius Health, College Board, Coinbase, DocuSign, Oracle, Wix, Hulu, Dropbox, Zoom, TurboTax |
| Code, passkey or "choose how to sign in" | 7: Amazon, Disney+, Uber, StubHub, Bilt, NFL, Airbnb |
| Blocked the test browser | 5: Google, Gmail, Spotify, Nike, Maryland Labor |
| Didn't move on | 9: Enter didn't submit, or the username wasn't recognized (Indeed, Home Depot, Microsoft…) |
| Page errors or timeouts | 7: Walmart, REI, Lucid, Amp and others |
| Not a login step | 4: X rejected the username, Binance showed sign-up, Target and Vista used the wrong box |

On every password screen it reached, the extension found the box. One was mislabeled:

- **TurboTax bug, fixed.** The password box is marked `autocomplete="current-password"`, but its id contains
  "password-confirmation", and the extension trusted the id. It labeled the login as a signup, so the
  email from step 1 would have been attached under signup rules. Now an explicit current-password marker
  wins. A regression test was added in `test/detection.test.js`.

**Takeaway:** many big sites (Amazon, Disney+, Uber, Airbnb) now push codes or passkeys before a password.
When you choose "Enter password instead", the password screen appears without a page load. That's the same
pattern the extension already handles.
