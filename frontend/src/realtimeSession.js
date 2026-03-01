import { RealtimeAgent, RealtimeSession, tool, backgroundResult } from '@openai/agents-realtime';
import { z } from 'zod';

const DEBUG = true;
const log = (...args) => { if (DEBUG) console.log(...args); };

export class RealtimeSessionController {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this._session = null;
    this._currentStatus = 'connecting';
    this._pendingAction = null;
  }

  get currentStatus() { return this._currentStatus; }

  async connect(clientSecret, instructions) {
    const self = this;

    const interviewCompleteTool = tool({
      name: 'interview_complete',
      description: 'Call this when the interview is finished and you have provided your verbal summary. This signals the application to generate the scorecard.',
      parameters: z.object({}),
      async execute() {
        self.cb.onInterviewComplete?.();
        return backgroundResult('Scorecard generation has been triggered.');
      },
    });

    const agent = new RealtimeAgent({
      name: 'AI Readiness Interviewer',
      instructions,
      tools: [interviewCompleteTool],
    });

    this._session = new RealtimeSession(agent, {
      config: {
        outputModalities: ['audio'],
        audio: {
          input: {
            format: 'pcm16',
            noise_reduction: { type: 'near_field' },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turnDetection: {
              type: 'server_vad',
              threshold: 0.7,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              createResponse: true,
              interruptResponse: true,
            },
          },
          output: {
            voice: 'marin',
            format: 'pcm16',
          }
        }
      },
    });

    this._session.on('audio_start', () => {
      log('Audio playback started');
      this.cb.onAudioStarted?.();
      this._setStatus('speaking', 'Speaking...');
    });

    this._session.on('audio_stopped', () => {
      log('Audio playback stopped');
      this.cb.onAudioStopped?.();
    });

    this._session.on('audio_interrupted', () => {
      log('Audio interrupted');
    });

    this._session.on('transport_event', (event) => this._handleEvent(event));
    this._session.on('error', (err) => {
      console.error('Session error:', err);
      this.cb.onError?.(err);
    });

    await this._session.connect({ apiKey: clientSecret });

    this._pendingAction = 'greeting';
  }

  close() {
    if (this._session) {
      try { this._session.close(); } catch (_) { /* ignore */ }
      this._session = null;
    }
  }

  _setStatus(status, text) {
    this._currentStatus = status;
    this.cb.onStatusChange?.(status, text);
  }

  _handleEvent(event) {
    switch (event.type) {
      case 'response.output_audio_transcript.delta':
        this.cb.onTranscriptDelta?.(event.delta);
        break;

      case 'response.output_audio_transcript.done':
        this.cb.onTranscriptDone?.(event.transcript);
        break;

      case 'response.done':
        log('Response DONE — id:', (event.response || {}).id, 'status:', (event.response || {}).status);
        this.cb.onResponseDone?.(event.response);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.cb.onUserTranscript?.(event.transcript);
        break;

      case 'input_audio_buffer.speech_started':
        log('VAD: speech_started');
        this._setStatus('listening', 'Hearing you...');
        break;

      case 'input_audio_buffer.speech_stopped':
        log('VAD: speech_stopped');
        this._setStatus('thinking', 'Thinking...');
        break;

      case 'response.created':
        log('Response created — id:', event.response?.id);
        if (this._currentStatus === 'listening') {
          this._setStatus('thinking', 'Thinking...');
        }
        break;

      case 'session.created':
        log('Session created:', JSON.stringify(event.session?.audio?.input?.turn_detection || 'no turn_detection'));
        break;

      case 'session.updated': {
        log('Session updated — output_modalities:', JSON.stringify(event.session?.output_modalities),
          'turn_detection:', JSON.stringify(event.session?.audio?.input?.turn_detection || event.session?.turn_detection || 'none'));
        const action = this._pendingAction;
        this._pendingAction = null;
        if (action === 'greeting') {
          log('Session configured, triggering greeting');
          try {
            this._session?.transport?.sendEvent({ type: 'response.create' });
          } catch (e) {
            console.warn('Failed to trigger greeting:', e);
          }
        }
        break;
      }

      case 'error':
        console.error('Realtime error:', event.error);
        this.cb.onError?.(event.error);
        break;

      default:
        break;
    }
  }
}
