/**
 * Hive Audio Capture — content script.
 * Requests a tabCapture stream ID from the background worker,
 * then uses getUserMedia with that ID to get the audio stream,
 * and pipes PCM data to the Hive WebSocket audio bridge.
 */

(function () {
  // Only activate on Zoom pages
  if (!location.hostname.includes('zoom.us')) return;

  // Wait for the bridge to be initialized by the init script
  let attempts = 0;
  const waitForBridge = setInterval(() => {
    attempts++;
    if (window.__hiveBridge) {
      clearInterval(waitForBridge);
      startCapture();
    }
    if (attempts > 30) { // 15 seconds
      clearInterval(waitForBridge);
      console.log('[hive-ext] Bridge not found after 15s, giving up');
    }
  }, 500);

  async function startCapture() {
    console.log('[hive-ext] Requesting tab audio stream ID...');

    try {
      const response = await chrome.runtime.sendMessage({ type: 'get-stream-id' });

      if (response.error) {
        console.log('[hive-ext] Error getting stream ID:', response.error);
        return;
      }

      const streamId = response.streamId;
      console.log('[hive-ext] Got stream ID, requesting audio...');

      // Use the stream ID with getUserMedia (bypasses our interception)
      const origGetUserMedia = navigator.mediaDevices.getUserMedia.__original || navigator.mediaDevices.getUserMedia;
      const stream = await origGetUserMedia.call(navigator.mediaDevices, {
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
      });

      const audioTracks = stream.getAudioTracks();
      console.log('[hive-ext] Tab audio stream obtained, tracks:', audioTracks.length);

      if (audioTracks.length > 0) {
        window.__hiveBridge.startCapture(audioTracks[0]);
        console.log('[hive-ext] Tab audio routed to Hive bridge');
      }
    } catch (e) {
      console.error('[hive-ext] Tab capture failed:', e.message);
    }
  }
})();
