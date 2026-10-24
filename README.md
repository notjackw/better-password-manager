# Password Manager (Chrome extension)

A password manager focused on one thing: **recognizing when you log in, sign up or reset a password,
and getting those credentials into the vault every time.**

> Security is intentionally out of scope for now. The vault is stored **unencrypted** in
> `chrome.storage.local`. Don't use it for accounts you care about until encryption is added.

## Why built-in password managers miss some logins

Example: **mlb.com/login**. Neither Chrome's password manager nor Apple Passwords recognizes it.

### The pattern: identifier-first login inside a single-page app

MLB uses the Okta Sign-In Widget. Many sites built on Okta, Auth0, Microsoft or Google sign-in
work the same way. The first screen has only an email box:

```html
<form action="/login" data-se="o-form">
  <h2>Enter Email Address</h2>
  <input type="text" name="identifier" autocomplete="username">
  <input type="submit" value="Continue">
</form>
```

After **Continue**, the page's own code replaces that form with a new one containing the password
box. The URL never changes and no new page loads.

### Why Chrome and Apple miss it

Their heuristics are closed source, so this is what we can observe, not their exact code:

1. **No password field, so no login form.** Built-in managers treat a form as a login mainly when it
   has an `<input type="password">`. The email screen has none, so the email isn't remembered as half of
   a login.
2. **The email is gone by the time the password is typed.** The second screen is a new form, and the
   email box no longer exists. The browser sees a lone password with nothing to pair it with.
3. **No sign that the login worked.** Browsers usually offer to save after a successful submit,
   often judged by a page load. Here the login happens in the background (XHR) and the address stays
   `/login`, so the "it worked, save it?" moment never clearly happens.

Each problem alone can be survivable. Together, nothing gets saved.

### How this extension catches it

| Problem | What this extension does |
| --- | --- |
| No password field on step 1 | A form with only a username-like field counts as **step one of a login** (`username-step` in `src/content/forms.js`) when the context says login: `/login` in the URL, sign-in words on buttons or headings, or `autocomplete="username"`. On submit it remembers the email for that tab (10 minutes). |
| Email gone on step 2 | When a password is submitted with no username next to it, the background pairs it with the email remembered from step 1. Only logins get this pairing, so a reset or signup page can't pick up the wrong account. |
| No page load to signal success | After submit, the page itself is watched (`src/content/outcome.js`). The password box disappearing (or a 2FA code box appearing) counts as success, with or without a page load. A new error message next to the password box counts as failure. |
| Still unsure | Nothing is thrown away. Anything that can't be confirmed lands in **Needs review** in the popup. |

### A harder variant: espn.com

On espn.com, **Log In** opens a popup, and the URL doesn't change. The popup is a full-screen
`<iframe id="oneid-iframe">` from `cdn.registerdisney.go.com`, Disney's shared login (also used by Disney+, ABC and Hulu).
The ESPN page itself has no login fields at all. Inside the frame it's the same email-then-password,
no-navigation flow as MLB, and on success ESPN closes the frame.

**Bitwarden, Apple Passwords and Chrome's password manager all fail to save this login.** That's what we
saw when testing them; their exact logic isn't documented, but each layer below is a known weak spot:

- **The login is in a frame from another site.** The fields belong to `registerdisney.go.com`, not
  `espn.com`. Managers that look only at the top page, or file logins under the address bar's site, either
  miss the fields or save them where they're never offered again.
- **Email and password are on separate screens.** Same problem as MLB: the password screen shows the email
  as plain text, not in a box, so there's no username to pair with the password.
- **There's no page load after logging in.** ESPN just closes the frame. Managers that wait for a
  navigation or a form submit to offer "Save password?" never get that signal.

The extension handles each layer:

- **Login in a frame from another site.** The extension runs inside every frame (`all_frames`), so the
  frame's fields are detected like any other. The login is filed under the frame's site (`go.com`),
  which is where it gets filled again, and remembers the page it was used on. The popup shows it as
  **go.com · used on espn.com** and lists it first while you're on ESPN.
- **The frame disappears on success.** If the login frame closes while the extension is still watching
  for the result, and no error has appeared, that counts as success. Otherwise the watcher would die
  with the frame and the login would end up in Needs review.
- **Brand names in hostnames.** A hostname counts as login/signup context only when a whole label is an
  auth word (`login.`, `accounts.`, `sso.`). Without that rule, "regis**ter**disney" read as *register*,
  and the password step looked like a signup.

`playground/modal-login.html` reproduces this: a `localhost` page that opens a frame from
`127.0.0.1` (a different site) with email, then password, closing on success.

In `playground/`, the **Two-step login** page tests pairing the email and password, and the
**Single-page app** page tests detecting success without a page load. `npm run e2e` checks both. No
playground page combines them on one URL the way MLB does yet.

## Install (development)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Reload any tabs that were already open.

After editing code, click the reload icon on the extension card, then reload the page you're testing.

## How capture works

1. **Field roles** (`src/content/fields.js`): each input is classified as username, password
   (current / new / confirm), one-time code, or generic text. The classifier uses autocomplete attributes,
   input type, name/id/placeholder/label text, and remembers fields that started as `type=password` so
   "show password" toggles don't break it.
2. **Groups and form kind** (`src/content/forms.js`): fields are grouped by `<form>`, or by the nearest
   container holding a password field and a button on formless pages (including open shadow DOM). Each
   group is labeled `login`, `signup`, `reset`, `change`, `username-step` or `otp`, using the password
   layout plus words in the URL, buttons and headings.
3. **Submission** (`src/content/capture.js`): a submit event, a click on a submit-like button, or Enter
   in a field. Values are remembered as you type, because many sites clear the password before submit
   finishes. Fallbacks: the page unloading or a filled password field disappearing.
4. **Did it work?** (`src/content/outcome.js`): after a submit, the same page (single-page apps) or the
   next page watches for the result:
   - **success**: password fields disappear, or a 2FA code step appears → saved to the vault with a toast and Undo
   - **failure**: a new error message appears next to the password field → **Needs review** (marked failed)
   - **unclear**: → **Needs review**
5. **Background** (`src/background/service-worker.js`) does the bookkeeping:
   - pairs the email from step 1 of two-step logins with the step 2 password
   - updates an existing account rather than duplicating it, keeping the last 10 old passwords
   - on resets with no username, updates the site's only account, or asks which account if there are several
   - when a login succeeds, clears earlier failed tries for the same account

Nothing that was typed and submitted is thrown away. Anything that isn't confirmed waits in
**Needs review** in the popup. A badge on the toolbar icon shows how many items are waiting.

## Using it

- **Autofill menu**: focus a username or password field to pick a saved login. On signup/reset fields
  it offers **Use a strong password**, which goes straight into Needs review in case the signup itself
  isn't detected.
- **Popup**: **Fill login**, **Save from page** (grabs what's typed in the page right now), search, edit,
  delete, and the review queue.
- **Shortcut**: `Alt+Shift+L` fills the best saved login on the page.
- **Import** (popup footer → *Import passwords (CSV)*): opens a page that reads CSV exports from Chrome,
  Safari/Apple Passwords or Firefox. New logins are added. A login you already have is never
  overwritten: if the file's password differs, the file's version goes to Needs review. Android app
  entries are skipped. Delete the exported CSV afterward, since it holds your passwords in plain text.

### Where the data lives

Everything is stored in `chrome.storage.local`, under the keys `vault` (saved logins) and `review` (Needs review):
- **Local only:** it stays on this computer and is never synced or sent anywhere.
- **Private to the extension:** websites and other extensions can't read it.
- **Not encrypted:** it's a file in your Chrome profile folder, readable by anyone with access to your user account.
- **Removed with the extension:** uninstalling it deletes the vault.

To look at it yourself: `chrome://extensions` → this extension → *service worker* → console →
`await chrome.storage.local.get(null)`.
- **Highlight detected fields** (popup footer): outlines every field with the role and form kind the
  heuristics chose. Use it when a site isn't being recognized.

## Tests

```sh
npm install
npm test        # detection heuristics against HTML fixtures (jsdom)
npm run e2e     # loads the extension into Chrome and walks through playground/
```

`playground/` has practice pages for each flow (form login, single-page app, two-step, signup, reset).
Use the password `wrong` to simulate a failed sign-in. To try them by hand, serve the folder with
`python3 -m http.server -d playground 8000`.

When a real site isn't recognized, the fastest fix is usually to copy the relevant HTML into a new
test in `test/detection.test.js`, make it pass, and keep it as a regression test.
