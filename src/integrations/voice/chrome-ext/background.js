/**
 * Hive Audio Capture — Chrome extension background worker.
 * Uses chrome.tabCapture to capture ALL audio from the active tab
 * (including WASM-rendered audio that bypasses Web Audio API).
 *
 * Communicates with the content script via chrome.runtime messaging.
 */

// Listen for capture requests from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start-capture') {
    console.log('[hive-ext] Starting tab audio capture for tab:', sender.tab?.id);

    chrome.tabCapture.capture(
      {
        audio: true,
        video: false,
      },
      (stream) => {
        if (chrome.runtime.lastError) {
          console.error('[hive-ext] tabCapture error:', chrome.runtime.lastError.message);
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }

        if (!stream) {
          sendResponse({ error: 'No stream returned' });
          return;
        }

        console.log('[hive-ext] Tab audio capture started, tracks:', stream.getAudioTracks().length);

        // We can't pass the stream directly to content script in MV3.
        // Instead, use an offscreen document or pipe through messaging.
        // For simplicity, create a MediaRecorder and send chunks.

        const audioCtx = new AudioContext({ sampleRate: 16000 });
        const source = audioCtx.createMediaStreamSource(stream);

        // Use ScriptProcessorNode (deprecated but works in service worker)
        // Actually, service workers don't have AudioContext. We need to
        // forward the stream ID to the content script instead.

        // Store stream globally so content script can access via offscreen
        globalThis.__hiveStream = stream;

        sendResponse({ ok: true, streamId: 'active' });
      }
    );

    return true; // async sendResponse
  }

  if (msg.type === 'get-stream') {
    // Content script requesting access to the captured stream
    if (globalThis.__hiveStream) {
      // Can't send MediaStream via messaging — need different approach
      sendResponse({ error: 'Cannot pass stream via messaging' });
    } else {
      sendResponse({ error: 'No active capture' });
    }
    return true;
  }
});

// Alternative: use chrome.tabCapture.getMediaStreamId for content script access
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-stream-id') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: 'No tab ID' });
      return true;
    }

    // getMediaStreamId gives an ID that can be used with getUserMedia in the content script
    chrome.tabCapture.getMediaStreamId(
      { targetTabId: tabId },
      (streamId) => {
        if (chrome.runtime.lastError) {
          console.error('[hive-ext] getMediaStreamId error:', chrome.runtime.lastError.message);
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }
        console.log('[hive-ext] Got stream ID for tab', tabId);
        sendResponse({ streamId });
      }
    );

    return true; // async
  }
});
