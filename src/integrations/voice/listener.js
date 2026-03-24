'use strict';

const { EventEmitter } = require('events');
const log = require('../../core/log');

/**
 * Meeting Listener — processes transcript in real-time to:
 * 1. Detect task requests (trigger phrases) → create tasks
 * 2. Extract learnings/decisions → write to knowledge base
 * 3. Answer ad-hoc questions about fleet status
 *
 * MVP: Uses keyword pattern matching instead of LLM API calls.
 */
class MeetingListener extends EventEmitter {
  constructor(opts = {}) {
    super();
    // Deepgram transcribes "hive" as many variants: hi, high, ty, five, etc.
    // Use a regex for trigger detection instead of exact phrases.
    // H matches any single-word transcription of "hive"
    // Deepgram transcribes "hive" unpredictably — match broadly
    const H = '(?:hive|hyve|hi|high|ty|five|fi|hy|how|hype|hyde)';
    this._triggerRegex = new RegExp(`(?:hey\\s+)?${H}\\b`, 'i');
    // Also trigger on direct command patterns (user may skip "hey hive")
    this._directCommandRegex = /\b(?:give|show|provide|tell)\s+(?:me|us)?\s*(?:a\s+)?(?:the\s+)?(?:status|update|report)\b/i;
    this.learningInterval = opts.learningInterval || 120000; // 2 min
    this.transcriptBuffer = [];
    this.lastLearningExtract = Date.now();
    this._learningTimer = null;
    const HEY_H = `(?:hey\\s*${H}|${H})`;

    // Task keywords — phrases that indicate someone is requesting work
    this._taskPatterns = [
      new RegExp(`${HEY_H}[,:]?\\s*(?:can you|could you|please|go ahead and)?\\s*(work on|start|create|build|fix|implement|add|update|write|deploy|ship|set up|configure)\\s+(.+)`, 'i'),
      new RegExp(`${HEY_H}[,:]?\\s*(?:new task|task)[:\\s]+(.+)`, 'i'),
      /(?:let's have|have)\s+(?:hive|hi|high|five)\s+(work on|start|create|build|fix|implement|add|update|write)\s+(.+)/i,
    ];

    // Question keywords — phrases that indicate someone is asking for info
    this._questionPatterns = [
      new RegExp(`${HEY_H}[,:]?\\s*(?:what(?:'s| is)|how(?:'s| is| are)|where|when|which|can you tell|do we have|are there|is there|status|update)\\s+(.+)`, 'i'),
      new RegExp(`${HEY_H}[,:]?\\s*(?:give me|show me|tell me|provide me|report)\\s+(.+)`, 'i'),
      // Match common questions even without "hive" prefix (trigger already detected)
      /what(?:'s| is)\s+(?:your |the )?\s*status/i,
      /(?:give|provide|show)\s+(?:me\s+)?(?:a\s+)?status/i,
    ];

    // Learning keywords — phrases that indicate decisions or insights
    this._learningPatterns = [
      /(?:we(?:'ve| have)?\s+decided|decision is|let's go with|we're going to|the plan is|agreed|moving forward with)\s+(.+)/i,
      /(?:important|key takeaway|lesson learned|note that|remember that|keep in mind)\s*[:\s]+(.+)/i,
      /(?:from now on|going forward|new rule|new process|policy)\s*[:\s]+(.+)/i,
    ];
  }

  /**
   * Process a transcript entry. Called on each 'transcript' event from Transcriber.
   */
  async processTranscript(entry, transcriber) {
    this.transcriptBuffer.push(entry);

    // Check for trigger phrases — normalize punctuation first because
    // Deepgram transcribes "hey hive" as "Hey. Hi." or "Hey, High." or "Five."
    const lower = entry.text.toLowerCase().replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ').trim();
    log.info(`[listener] Processing: "${entry.text}" → normalized: "${lower}"`);
    const triggered = this._triggerRegex.test(lower) || this._directCommandRegex.test(lower);

    if (triggered) {
      log.info(`[listener] Trigger detected: "${entry.text}"`);
      // Wait briefly for follow-up context (transcript may be split across entries)
      await new Promise(r => setTimeout(r, 2000));
      const recentText = transcriber.getRecentTranscript(10); // last 10 seconds
      log.info(`[listener] Context for trigger: "${recentText}"`);
      this._handleTrigger(recentText);
    }

    // Periodic learning extraction
    if (Date.now() - this.lastLearningExtract >= this.learningInterval) {
      this.lastLearningExtract = Date.now();
      const window = transcriber.getRecentTranscript(120);
      if (window.trim()) {
        this._extractLearnings(window);
      }
    }
  }

  /**
   * Handle a trigger phrase — determine if it's a task request or a question.
   * Uses keyword pattern matching (no LLM needed).
   */
  _handleTrigger(text) {
    // Strip speaker labels and normalize punctuation from combined transcript context
    text = text.replace(/\[Speaker \d+\]\s*/g, '').replace(/\[Unknown\]\s*/g, '')
      .replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Check for task patterns
    for (const pattern of this._taskPatterns) {
      const match = text.match(pattern);
      if (match) {
        // Extract the task content (last capture group)
        const content = match[match.length - 1].trim().replace(/[.!?]+$/, '');
        if (content.length > 3) {
          log.info(`[listener] Task detected: "${content}"`);
          this.emit('task', {
            text: content,
            priority: this._detectPriority(text),
            context: text,
          });
          return;
        }
      }
    }

    // Check for question patterns
    for (const pattern of this._questionPatterns) {
      const match = text.match(pattern);
      if (match) {
        const question = match[match.length - 1].trim().replace(/[.!?]+$/, '');
        if (question.length > 3) {
          log.info(`[listener] Question detected: "${question}"`);
          this.emit('question', {
            question,
            context: text,
          });
          return;
        }
      }
    }

    // Trigger detected but no clear task or question — log it
    log.info(`[listener] Trigger heard but no actionable pattern matched: "${text}"`);
  }

  /**
   * Extract learnings and decisions from a transcript window.
   * Uses keyword pattern matching (no LLM needed).
   */
  _extractLearnings(transcriptWindow) {
    const lines = transcriptWindow.split('\n').filter(l => l.trim());
    const learnings = [];

    for (const line of lines) {
      for (const pattern of this._learningPatterns) {
        const match = line.match(pattern);
        if (match) {
          const insight = match[match.length - 1].trim().replace(/[.!?]+$/, '');
          if (insight.length > 10) {
            learnings.push({
              insight,
              domain: this._detectDomain(insight),
            });
          }
          break; // one match per line is enough
        }
      }
    }

    if (learnings.length > 0) {
      log.info(`[listener] Extracted ${learnings.length} learnings`);
      this.emit('learnings', learnings);
    }
  }

  /**
   * Detect priority from text keywords.
   */
  _detectPriority(text) {
    const lower = text.toLowerCase();
    if (/\b(urgent|asap|immediately|critical|blocker|right now|drop everything)\b/.test(lower)) return 'high';
    if (/\b(when you get a chance|low priority|eventually|backlog|nice to have)\b/.test(lower)) return 'low';
    return 'normal';
  }

  /**
   * Detect domain from insight text.
   */
  _detectDomain(text) {
    const lower = text.toLowerCase();
    if (/\b(api|backend|server|database|endpoint|migration|deploy|ci|cd|pipeline)\b/.test(lower)) return 'engineering';
    if (/\b(ui|ux|frontend|design|component|page|screen|layout)\b/.test(lower)) return 'frontend';
    if (/\b(product|feature|roadmap|user|customer|requirement|spec)\b/.test(lower)) return 'product';
    if (/\b(process|workflow|standup|review|sprint|meeting|team)\b/.test(lower)) return 'process';
    if (/\b(security|auth|permission|access|token|credential)\b/.test(lower)) return 'security';
    return 'general';
  }

  /**
   * Stop periodic extraction.
   */
  stop() {
    if (this._learningTimer) {
      clearInterval(this._learningTimer);
      this._learningTimer = null;
    }
  }
}

module.exports = MeetingListener;
