/**
 * Server-backed recognition engine for browsers without the Web Speech API
 * (notably Firefox).
 *
 * Records silence-delimited utterances with MediaRecorder, monitors the
 * input level with WebAudio to detect the end of speech, and sends each
 * segment to the `wandavoicetranscribe` API module, which forwards it to the
 * wiki's configured Whisper-compatible speech-to-text service.
 *
 * Exposes the same interface as VoiceRecognition (start/stop/captureNow/
 * resumeWake/enabled + the same handler callbacks) so init.js can use either
 * engine interchangeably. Unlike the browser engine there is no passive
 * wake-phrase stage: recording only happens while the user has explicitly
 * turned listening on (push-to-talk model), which also avoids streaming
 * ambient audio to the server.
 */

/** Milliseconds of silence that end an utterance. */
const SILENCE_MS = 1300;
/** Maximum length of a single utterance segment. */
const MAX_SEGMENT_MS = 30000;
/** Normalised RMS level above which the input counts as speech. */
const SPEECH_THRESHOLD = 0.02;
/** Segments without any detected speech are discarded client-side. */
const MIN_BLOB_BYTES = 2048;

class ServerRecognition {
	/**
	 * @param {Object} config wgWandaVoice configuration object
	 * @param {Object} handlers { onWake, onCommand, onInterim, onStateChange, onError }
	 */
	constructor( config, handlers ) {
		this.config = config;
		this.handlers = handlers;
		this.api = new mw.Api();
		this.enabled = false;
		this.stream = null;
		this.audioContext = null;
		this.analyser = null;
		this.recorder = null;
		this.monitorTimer = null;
		this.mimeType = '';
	}

	/**
	 * @return {boolean} Whether this engine can run in the current browser
	 */
	static isSupported() {
		return !!( navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
			// eslint-disable-next-line compat/compat -- presence is feature-detected here
			window.MediaRecorder );
	}

	/** Start listening (asks for microphone access on first use). */
	start() {
		if ( this.enabled ) {
			return;
		}
		this.enabled = true;
		navigator.mediaDevices.getUserMedia( { audio: true } ).then(
			( stream ) => {
				if ( !this.enabled ) {
					stream.getTracks().forEach( ( track ) => track.stop() );
					return;
				}
				this.stream = stream;
				this.setupAnalyser();
				this.beginSegment();
				this.handlers.onStateChange( 'capture' );
			},
			() => {
				this.enabled = false;
				this.handlers.onError( 'mic-denied' );
			}
		);
	}

	/** Stop listening entirely and release the microphone. */
	stop() {
		this.enabled = false;
		this.stopMonitor();
		if ( this.recorder && this.recorder.state !== 'inactive' ) {
			this.recorder.onstop = null;
			try {
				this.recorder.stop();
			} catch ( e ) {
				// Already stopped.
			}
		}
		this.recorder = null;
		if ( this.stream ) {
			this.stream.getTracks().forEach( ( track ) => track.stop() );
			this.stream = null;
		}
		if ( this.audioContext ) {
			this.audioContext.close();
			this.audioContext = null;
			this.analyser = null;
		}
		this.handlers.onStateChange( 'off' );
	}

	/** Push-to-talk: ensure a capture segment is running. */
	captureNow() {
		if ( !this.enabled ) {
			this.start();
			return;
		}
		if ( !this.recorder || this.recorder.state === 'inactive' ) {
			this.beginSegment();
		}
		this.handlers.onStateChange( 'capture' );
	}

	/** Called after a command was handled; keep capturing in continuous mode. */
	resumeWake() {
		if ( !this.enabled ) {
			return;
		}
		if ( !this.config.continuousMode ) {
			this.stop();
			return;
		}
		this.beginSegment();
		this.handlers.onStateChange( 'capture' );
	}

	/** Create the WebAudio analyser used for end-of-speech detection. */
	setupAnalyser() {
		try {
			// eslint-disable-next-line compat/compat -- wrapped in try/catch, optional
			const Ctor = window.AudioContext || window.webkitAudioContext;
			this.audioContext = new Ctor();
			const source = this.audioContext.createMediaStreamSource( this.stream );
			this.analyser = this.audioContext.createAnalyser();
			this.analyser.fftSize = 512;
			source.connect( this.analyser );
		} catch ( e ) {
			// Without an analyser, segments end at the maximum duration only.
			this.analyser = null;
		}
	}

	/**
	 * @return {number} Normalised RMS input level (0-1)
	 */
	inputLevel() {
		if ( !this.analyser ) {
			return 0;
		}
		const data = new Uint8Array( this.analyser.fftSize );
		this.analyser.getByteTimeDomainData( data );
		let sum = 0;
		for ( let i = 0; i < data.length; i++ ) {
			const deviation = ( data[ i ] - 128 ) / 128;
			sum += deviation * deviation;
		}
		return Math.sqrt( sum / data.length );
	}

	/** Record one silence-delimited utterance segment. */
	beginSegment() {
		if ( !this.stream ) {
			return;
		}
		if ( !this.mimeType ) {
			this.mimeType = [
				'audio/webm;codecs=opus',
				'audio/webm',
				'audio/ogg;codecs=opus',
				'audio/mp4'
			].find( ( type ) => MediaRecorder.isTypeSupported( type ) ) || '';
		}

		const chunks = [];
		let hadSpeech = false;
		// eslint-disable-next-line compat/compat -- only reached when isSupported() passed
		const recorder = new MediaRecorder( this.stream, this.mimeType ?
			{ mimeType: this.mimeType, audioBitsPerSecond: 32000 } :
			{ audioBitsPerSecond: 32000 } );
		this.recorder = recorder;

		recorder.ondataavailable = ( event ) => {
			if ( event.data && event.data.size ) {
				chunks.push( event.data );
			}
		};
		recorder.onstop = () => {
			this.stopMonitor();
			const blob = new Blob( chunks, { type: recorder.mimeType } );
			if ( !this.enabled || !hadSpeech || blob.size < MIN_BLOB_BYTES ) {
				// Nothing worth transcribing; keep listening.
				if ( this.enabled ) {
					this.beginSegment();
				}
				return;
			}
			this.transcribe( blob );
		};

		try {
			recorder.start( 250 );
		} catch ( e ) {
			this.handlers.onError( 'generic' );
			return;
		}

		const startedAt = Date.now();
		let lastVoice = Date.now();
		this.stopMonitor();
		this.monitorTimer = setInterval( () => {
			if ( recorder.state !== 'recording' ) {
				this.stopMonitor();
				return;
			}
			const now = Date.now();
			if ( this.inputLevel() > SPEECH_THRESHOLD ) {
				hadSpeech = true;
				lastVoice = now;
			}
			if ( ( hadSpeech && now - lastVoice > SILENCE_MS ) ||
				now - startedAt > MAX_SEGMENT_MS
			) {
				recorder.stop();
			}
		}, 100 );
	}

	stopMonitor() {
		if ( this.monitorTimer ) {
			clearInterval( this.monitorTimer );
			this.monitorTimer = null;
		}
	}

	/**
	 * Send a recorded utterance to the server for transcription.
	 *
	 * @param {Blob} blob
	 */
	transcribe( blob ) {
		this.handlers.onStateChange( 'processing' );

		const reader = new FileReader();
		reader.onload = () => {
			const base64 = String( reader.result ).split( ',' )[ 1 ] || '';
			// The recorder may report parameters ("audio/webm;codecs=opus").
			const baseMime = ( blob.type || 'audio/webm' ).split( ';' )[ 0 ];
			this.api.post( {
				action: 'wandavoicetranscribe',
				format: 'json',
				audio: base64,
				mimetype: baseMime,
				lang: this.config.language || ''
			} ).then(
				( data ) => {
					const text = ( data && data.text || '' ).trim();
					if ( text ) {
						this.handlers.onCommand( text );
					} else if ( this.enabled ) {
						this.resumeWake();
					}
				},
				() => {
					this.handlers.onError( 'generic' );
					if ( this.enabled ) {
						this.resumeWake();
					}
				}
			);
		};
		reader.onerror = () => {
			this.handlers.onError( 'generic' );
			if ( this.enabled ) {
				this.resumeWake();
			}
		};
		reader.readAsDataURL( blob );
	}
}

module.exports = ServerRecognition;
