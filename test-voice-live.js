const WebSocket = require('ws');
const token = require('fs').readFileSync('/Users/dev/dev/hive/.env', 'utf8')
  .split('\n').find(l => l.startsWith('WEB_TOKEN='))?.split('=')[1];

const ws = new WebSocket('ws://127.0.0.1:3000');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'auth' && msg.ok) {
    console.log('Authenticated. Sending voice:leave first...');
    ws.send(JSON.stringify({ type: 'voice:leave' }));

    setTimeout(() => {
      console.log('Joining meeting...');
      ws.send(JSON.stringify({
        type: 'voice:join',
        url: 'https://us02web.zoom.us/j/2120045747',
        botName: 'Hive',
        reportOnJoin: true,
      }));
    }, 2000);

    // Poll debug every 10s
    setInterval(() => {
      ws.send(JSON.stringify({ type: 'voice:debug' }));
    }, 10000);
  } else if (msg.type === 'voice:debug') {
    const d = msg.debug;
    console.log(`[${new Date().toLocaleTimeString()}] audio:${d.audioChunksReceived} transcripts:${d.transcriptLength} deepgram:${d.transcriberRunning} bridge:${d.audioBridgeConnected} tracks:${d.browserBridge?.capturedTracks}`);
  } else if (msg.type === 'voice:transcript') {
    console.log('TRANSCRIPT:', JSON.stringify(msg.transcript));
  } else if (msg.type && msg.type.startsWith('voice:')) {
    console.log('VOICE:', msg.type, JSON.stringify(msg).substring(0, 200));
  } else if (msg.type === 'error') {
    console.log('ERROR:', msg.message);
  }
});

ws.on('error', (e) => console.error('WS error:', e.message));
setTimeout(() => { ws.close(); process.exit(0); }, 300000); // 5 min
