export async function sendTelegram({ token, chatId, text, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Telegram request failed with HTTP ${response.status}`);
  const result = await response.json();
  if (!result?.ok) throw new Error('Telegram rejected the notification');
  return {
    messageId: result.result?.message_id ?? null,
    sentAt: Number.isFinite(result.result?.date) ? new Date(result.result.date * 1000).toISOString() : null
  };
}

