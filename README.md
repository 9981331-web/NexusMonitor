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
