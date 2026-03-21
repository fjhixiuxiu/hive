'use strict';

const log = require('../../core/log');

/**
 * TTS Engine — converts text to speech using Deepgram's TTS API.
 * Returns raw PCM audio buffers for injection into the meeting.
 */
class TTS {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.DEEPGRAM_API_KEY;
    this.voice = opts.voice || 'aura-orion-en'; // deep, professional
    if (!this.apiKey) log.warn('[tts] DEEPGRAM_API_KEY not set — TTS will not work');
  }

  /**
   * Convert text to speech via Deepgram REST API.
   * @param {string} text - Text to speak
   * @returns {Buffer} - Raw 24kHz 16-bit mono PCM audio
   */
  async speak(text) {
    if (!this.apiKey) throw new Error('DEEPGRAM_API_KEY required for TTS');
    log.info(`[tts] Generating speech (${text.length} chars, voice: ${this.voice})`);

    const resp = await fetch(`https://api.deepgram.com/v1/speak?model=${this.voice}&encoding=linear16&sample_rate=24000`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Deepgram TTS error ${resp.status}: ${err}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    log.info(`[tts] Generated ${buffer.length} bytes of audio`);
    return buffer;
  }

  /**
   * Split long text into chunks suitable for TTS (max ~2000 chars).
   * Splits at sentence boundaries.
   */
  splitText(text, maxLen = 2000) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('. ', maxLen);
      if (splitAt === -1) splitAt = remaining.lastIndexOf('! ', maxLen);
      if (splitAt === -1) splitAt = remaining.lastIndexOf('? ', maxLen);
      if (splitAt === -1) splitAt = maxLen;
      else splitAt += 2;
      chunks.push(remaining.substring(0, splitAt).trim());
      remaining = remaining.substring(splitAt).trim();
    }
    return chunks;
  }
}

module.exports = TTS;
