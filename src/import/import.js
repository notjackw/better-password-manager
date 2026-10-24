const PM = globalThis.PM;
const $ = (sel) => document.querySelector(sel);

function show(text, isError = false) {
  $('#result').textContent = text;
  $('#result').classList.toggle('error', isError);
}

// The background normally answers in milliseconds; if it doesn't, say so instead of hanging silently.
function sendWithTimeout(msg, ms = 15000) {
  return Promise.race([
    chrome.runtime.sendMessage(msg),
    new Promise((_, reject) => setTimeout(() => reject(new Error('The extension background did not respond.')), ms)),
  ]);
}

$('#file').addEventListener('change', () => {
  const file = $('#file').files[0];
  $('#go').disabled = !file;
  show(file ? `Selected ${file.name}. Click Import.` : '');
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#file').files[0];
  if (!file) return;
  $('#go').disabled = true;
  show(`Reading ${file.name}…`);
  try {
    const parsed = PM.credentialsFromCsv(await file.text());
    if (!parsed.creds.length) {
      show(`No website logins found in ${file.name} (skipped ${parsed.skipped} rows).`, true);
      return;
    }
    show(`Importing ${parsed.creds.length} logins…`);
    const res = await sendWithTimeout({ type: 'IMPORT', creds: parsed.creds });
    if (!res || res.error) throw new Error(res?.error || 'The extension background did not answer.');
    const { added, unchanged, conflicts } = res;
    const lines = [`✓ Imported ${added} new login${added === 1 ? '' : 's'}.`];
    if (unchanged) lines.push(`${unchanged} were already saved.`);
    if (conflicts) lines.push(`${conflicts} differ from what's saved: open the extension and check Needs review.`);
    if (parsed.skipped) lines.push(`Skipped ${parsed.skipped} (app logins or rows without a password).`);
    lines.push(`You can delete ${file.name} now. It holds your passwords in plain text.`);
    show(lines.join('\n'));
  } catch (err) {
    console.error('Import failed', err);
    show(`Import failed: ${err.message}\n\nTry reloading the extension at chrome://extensions, then reopen this page.`, true);
  } finally {
    $('#go').disabled = false;
  }
});
