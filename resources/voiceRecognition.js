/**
 * Web Speech API wrapper for WandaVoice.
 *
 * Owns the browser SpeechRecognition instance and implements the two-stage
 * listening model:
 *
 *  - "wake" stage: passively listens and fuzzy-matches the transcript
 *    against the configured wake phrase.
 *  - "capture" stage: records the actual command until a final result is
 *    produced, emitting interim transcripts along the way.
 *
 * No audio ever leaves the browser: the Web Speech API performs the
 * transcription and only the resulting text is processed further.
 */

/**
 * Levenshtein distance between two strings (iterative, two-row).
 *
 * @param {string} a
 * @param {string} b
 * @return {number}
 */
function levenshtein( a, b ) {
	if ( a === b ) {
		return 0;
	}
	if ( !a.length || !b.length ) {
		return a.length || b.length;
	}
	let prev = Array.from( { length: b.length + 1 }, ( _, i ) => i );
	for ( let i = 1; i <= a.length; i++ ) {
		const curr = [ i ];
		for ( let j = 1; j <= b.length; j++ ) {
			curr[ j ] = Math.min(
				prev[ j ] + 1,
				curr[ j - 1 ] + 1,
				prev[ j - 1 ] + ( a[ i - 1 ] === b[ j - 1 ] ? 0 : 1 )
			);
		}
		prev = curr;
	}
	return prev[ b.length ];
}

/**
 * Normalised similarity between 0 and 1.
 *
 * @param {string} a
 * @param {string} b
 * @return {number}
 */
function similarity( a, b ) {
	const maxLen = Math.max( a.length, b.length );
	return maxLen === 0 ? 1 : 1 - levenshtein( a, b ) / maxLen;
}

/**
 * @param {string} text
 * @return {string}
 */
function normalize( text ) {
	return text.toLowerCase().replace( /[^\p{L}\p{N}\s]/gu, '' ).replace( /\s+/g, ' ' ).trim();
}

class VoiceRecognition {
	/**
	 * @param {Object} config wgWandaVoice configuration object
	 * @param {Object} handlers { onWake, onCommand, onInterim, onStateChange, onError }
	 */
	constructor( config, handlers ) {
		this.config = config;
		this.handlers = handlers;
		this.recognition = null;
		this.enabled = false;
		// 'wake' (waiting for wake phrase) or 'capture' (recording a command)
		this.stage = 'wake';
		this.langIndex = 0;
		this.languages = [ config.language ].concat( config.fallbackLanguages || [] );
		this.wakePhrase = normalize( config.wakePhrase || '' );
	}

	/**
	 * @return {boolean} Whether the browser supports speech recognition
	 */
	static isSupported() {
		return !!( window.SpeechRecognition || window.webkitSpeechRecognition );
	}

	/**
	 * Start listening. Enters wake stage when a wake phrase is configured,
	 * otherwise captures the next utterance directly.
	 */
	start() {
		if ( this.enabled ) {
			return;
		}
		this.enabled = true;
		this.stage = this.wakePhrase ? 'wake' : 'capture';
		this.createRecognition();
		this.handlers.onStateChange( this.stage );
	}

	/** Stop listening entirely. */
	stop() {
		this.enabled = false;
		if ( this.recognition ) {
			this.recognition.onend = null;
			try {
				this.recognition.stop();
			} catch ( e ) {
				// Already stopped.
			}
			this.recognition = null;
		}
		this.handlers.onStateChange( 'off' );
	}

	/** Skip the wake phrase and capture the next utterance (push-to-talk). */
	captureNow() {
		this.stage = 'capture';
		this.handlers.onStateChange( 'capture' );
	}

	/** Return to wake-phrase listening after a command has been handled. */
	resumeWake() {
		if ( !this.enabled ) {
			return;
		}
		this.stage = this.wakePhrase && this.config.continuousMode ? 'wake' : 'capture';
		if ( !this.config.continuousMode && !this.wakePhrase ) {
			this.stop();
			return;
		}
		this.handlers.onStateChange( this.stage );
	}

	/**
	 * Create and start the underlying SpeechRecognition object.
	 */
	createRecognition() {
		const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
		const recognition = new SpeechRecognitionCtor();

		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = this.languages[ this.langIndex ] || '';

		recognition.onresult = ( event ) => this.handleResult( event );
		recognition.onerror = ( event ) => this.handleError( event );
		recognition.onend = () => {
			// Browsers stop recognition after silence; restart while enabled.
			if ( this.enabled ) {
				try {
					recognition.start();
				} catch ( e ) {
					// Start can throw if called too quickly; retry shortly.
					setTimeout( () => {
						if ( this.enabled && this.recognition === recognition ) {
							try {
								recognition.start();
							} catch ( err ) {
								this.handlers.onError( 'generic' );
							}
						}
					}, 250 );
				}
			}
		};

		this.recognition = recognition;
		try {
			recognition.start();
		} catch ( e ) {
			this.handlers.onError( 'generic' );
		}
	}

	/**
	 * @param {Object} event SpeechRecognition result event
	 */
	handleResult( event ) {
		let interim = '';
		let finalText = '';
		for ( let i = event.resultIndex; i < event.results.length; i++ ) {
			const result = event.results[ i ];
			if ( result.isFinal ) {
				finalText += result[ 0 ].transcript;
			} else {
				interim += result[ 0 ].transcript;
			}
		}

		if ( this.stage === 'wake' ) {
			const heard = normalize( finalText || interim );
			if ( heard && this.matchesWakePhrase( heard ) ) {
				const remainder = this.stripWakePhrase( heard );
				this.handlers.onWake();
				this.stage = 'capture';
				this.handlers.onStateChange( 'capture' );
				// Wake phrase and command spoken in one breath.
				if ( remainder && finalText ) {
					this.stage = 'processing';
					this.handlers.onCommand( remainder );
				}
			}
			return;
		}

		if ( this.stage === 'capture' ) {
			if ( interim ) {
				this.handlers.onInterim( interim );
			}
			let command = finalText.trim();
			if ( command ) {
				// The wake phrase and command may arrive in the same final
				// result when spoken in one breath.
				const heard = normalize( command );
				if ( this.wakePhrase && this.matchesWakePhrase( heard ) ) {
					command = this.stripWakePhrase( heard );
					if ( !command ) {
						return;
					}
				}
				this.stage = 'processing';
				this.handlers.onCommand( command );
			}
		}
	}

	/**
	 * Fuzzy wake phrase match honouring the configured sensitivity.
	 *
	 * @param {string} heard Normalised transcript
	 * @return {boolean}
	 */
	matchesWakePhrase( heard ) {
		if ( heard.includes( this.wakePhrase ) ) {
			return true;
		}
		const threshold = Math.min( 1, Math.max( 0, this.config.wakeSensitivity || 0.7 ) );
		const wakeWordCount = this.wakePhrase.split( ' ' ).length;
		const words = heard.split( ' ' );
		// Compare every window of the same word length as the wake phrase.
		for ( let i = 0; i + wakeWordCount <= words.length; i++ ) {
			const windowText = words.slice( i, i + wakeWordCount ).join( ' ' );
			if ( similarity( windowText, this.wakePhrase ) >= threshold ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Remove the wake phrase (or its fuzzy match) from the transcript,
	 * returning any trailing command text.
	 *
	 * @param {string} heard Normalised transcript
	 * @return {string}
	 */
	stripWakePhrase( heard ) {
		const exact = heard.indexOf( this.wakePhrase );
		if ( exact !== -1 ) {
			return heard.slice( exact + this.wakePhrase.length ).trim();
		}
		const threshold = Math.min( 1, Math.max( 0, this.config.wakeSensitivity || 0.7 ) );
		const wakeWordCount = this.wakePhrase.split( ' ' ).length;
		const words = heard.split( ' ' );
		for ( let i = 0; i + wakeWordCount <= words.length; i++ ) {
			const windowText = words.slice( i, i + wakeWordCount ).join( ' ' );
			if ( similarity( windowText, this.wakePhrase ) >= threshold ) {
				return words.slice( i + wakeWordCount ).join( ' ' ).trim();
			}
		}
		return '';
	}

	/**
	 * @param {Object} event SpeechRecognition error event
	 */
	handleError( event ) {
		if ( event.error === 'not-allowed' || event.error === 'service-not-allowed' ) {
			this.stop();
			this.handlers.onError( 'mic-denied' );
		} else if ( event.error === 'language-not-supported' &&
			this.langIndex < this.languages.length - 1
		) {
			// Try the next configured fallback language.
			this.langIndex++;
			if ( this.recognition ) {
				this.recognition.lang = this.languages[ this.langIndex ];
			}
		} else if ( event.error !== 'no-speech' && event.error !== 'aborted' ) {
			this.handlers.onError( 'generic' );
		}
	}
}

module.exports = VoiceRecognition;
