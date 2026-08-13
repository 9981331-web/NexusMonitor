# Nexus Court Monitor

Local monitor for up to two public court case pages. It fingerprints the visible case card
and sends immediate Telegram alerts for card, hearing, or status changes.

## Safety behavior

- Monitoring refuses to start without a real `COURT_CASE_URL`, bot token, and chat ID.
- The first successful check creates a baseline and sends nothing.
- Polls run only Monday-Friday at 12:08 and 18:08 Europe/Moscow; weekends are skipped.
- After the 18:08 poll, it sends exactly one daily no-change heartbeat only when no
  change alert was sent that Moscow calendar day.
- A semantic `<main>` case card is preferred, excluding changing headers and footers.
- State advances only after Telegram accepts a change notification, so failed sends retry.
- Logs contain outcomes only. They never include the token, chat ID, page body, or URL query.
- `.env`, state, and logs are ignored by Git. `.env` paths inside OneDrive or an Obsidian
  vault are rejected.

## Configure

1. Copy `.env.example` to `.env` in `C:\NEXUS\nexus-court-monitor`.
2. Set the existing bot token in `TELEGRAM_BOT_TOKEN`. Do not paste it into chat or source files.
3. Set `TELEGRAM_CHAT_ID` and a direct public `COURT_CASE_URL`. Use `COURT_CASE_URL_2` for a second case.
4. Set `COURT_CASE_NUMBER` when known. A case number alone is not enough because court
   sites do not share a universal lookup API.
5. Run `npm.cmd run check`. This validates configuration but performs no network request.
6. Run `npm.cmd run once` to establish the first baseline. This fetches the court page but
   sends no message on a new baseline.
7. After inspecting `data\state.json`, run `npm.cmd start` to schedule weekday checks.

The parser supports Russian and English hearing/status terms and fingerprints the complete
visible main case card. Court sites with JavaScript-only content, CAPTCHA, or unusual markup
may require a site-specific adapter after the real URL is known.

## Local validation

```powershell
npm.cmd test
npm.cmd run check
```

Neither command sends external messages. Tests use local HTML fixtures and fake network functions.
## Russian Post Monitor (local Windows component)

`RussianPostMonitor` is an independent read-only component in this repository. It reuses the existing Telegram bot transport but does not run in GitHub Actions and does not change the Court Monitor workflow.

- production schedule: daily at 14:00 `Europe/Moscow`;
- bounded recovery: an additional logon trigger may recover the occurrence only from 14:00 through 15:59;
- source: the authorized `https://www.pochta.ru/tracking` account page and its structured same-origin response;
- browser authorization: a dedicated persistent Chrome profile under `%LOCALAPPDATA%\Nexus\RussianPostMonitor\profile`;
- user completes login, OTP, and CAPTCHA manually; the monitor never stores the account password;
- Telegram token and discovered chat ID: CurrentUser DPAPI files under `%LOCALAPPDATA%\Nexus\RussianPostMonitor\secrets`;
- atomic comparison state: `%LOCALAPPDATA%\Nexus\RussianPostMonitor\state\state.json`;
- profile, secrets, state, and diagnostics are outside Git and restricted to the current Windows user.

The first successful account read is a baseline. Historical shipments are recorded without being announced as new. Later daily checks report newly observed registered incoming shipments and outgoing shipments that first reach an official addressee-delivery operation. Operation type `2` is accepted only with an official addressee attribute; sender-return attributes and intermediate states such as arrival at the delivery office are not delivery.

Direction is determined from the sender/recipient fields in the structured account response. The account party must be uniquely identifiable from its repeated sender/recipient role; ambiguous data fails closed. A failed login, network request, or parse never becomes a false “no new mail” summary and never replaces the last good shipment state.

Daily dedupe uses the Moscow calendar date. Shipment dedupe uses the tracking ID plus meaningful delivery occurrence. A process lock prevents simultaneous checks, and state is written only after Telegram accepts the daily message.

Local commands:

```powershell
npm.cmd run russian-post:check
npm.cmd run russian-post:login
npm.cmd run russian-post:probe
npm.cmd run russian-post:once
npm.cmd run russian-post:scheduled
```

Run `scripts\configure-russian-post.ps1` only when local DPAPI Telegram configuration is absent. It asks for the existing bot token, validates the bot, and discovers the private chat ID from a fresh message to that bot. Install the Windows task with `scripts\install-russian-post-task.ps1` only after the controlled live E2E succeeds.

If authorization expires, run `npm.cmd run russian-post:login`, complete authentication manually in the dedicated window, close it, and verify with `npm.cmd run russian-post:probe`.

Production verification on 2026-08-13:

- authorized account read: 6 incoming and 3 outgoing shipments;
- activation baseline saved atomically after Telegram returned success;
- a fresh process decrypted DPAPI credentials, reused the browser session, and read the same 6/3 snapshot;
- repeat `once` returned `already-processed` with `notified=false`;
- controlled unchanged daily test produced one explicit no-new summary and deduped its restart;
- Windows task `Nexus Russian Post Monitor` is Ready, runs daily at 14:00 local Moscow time, and has a logon recovery trigger bounded in code to 14:00–15:59;
- an out-of-window task run exited successfully without reading/sending a daily occurrence;
- complete test suite: 29 passed, 0 failed, including the existing Court Monitor regression tests;
- `.github/workflows/court-monitor.yml` remains unchanged.
