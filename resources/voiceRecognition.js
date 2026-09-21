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
 * The browser speech service performs transcription and may send audio to
 * its provider. WandaVoice receives and processes the resulting text.
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
 * Tokenise for comparison while retaining UTF-16 offsets into the original text.
 * Combining marks remain part of their word; punctuation separates words.
 *
 * @param {string} text
 * @return {Array<Object>}
 */
function words( text ) {
	return Array.from( text.matchAll( /[\p{L}\p{N}\p{M}]+/gu ), ( match ) => ( {
		text: match[ 0 ].normalize( 'NFC' ).toLowerCase(),
		end: match.index + match[ 0 ].length
	} ) );
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
		this.restartTimer = null;
		this.enabled = false;
		// 'wake' (waiting for wake phrase) or 'capture' (recording a command)
		this.stage = 'wake';
		this.langIndex = 0;
		this.languages = [ config.language ].concat( config.fallbackLanguages || [] );
		this.wakeWords = words( config.wakePhrase || '' ).map( ( word ) => word.text );
		this.wakePhrase = this.wakeWords.join( ' ' );
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
		if ( this.enabled ) {
			this.handlers.onStateChange( this.stage );
		}
	}

	/** Stop listening entirely. */
	stop() {
		this.enabled = false;
		this.stage = 'off';
		clearTimeout( this.restartTimer );
		this.restartTimer = null;
		if ( this.recognition ) {
			const recognition = this.recognition;
			// Invalidate before aborting: abort/stop can dispatch final events.
			this.recognition = null;
			recognition.onresult = null;
			recognition.onerror = null;
			recognition.onend = null;
			try {
				if ( typeof recognition.abort === 'function' ) {
					recognition.abort();
				} else {
					recognition.stop();
				}
			} catch ( e ) {
				// Already stopped.
			}
		}
		this.handlers.onStateChange( 'off' );
	}

	/** Skip the wake phrase and capture the next utterance (push-to-talk). */
	captureNow() {
		if ( !this.enabled ) {
			return;
		}
		this.stage = 'capture';
		this.handlers.onStateChange( 'capture' );
	}

	/** Return to wake-phrase listening after a command has been handled. */
	resumeWake() {
		if ( !this.enabled ) {
			return;
		}
		this.stage = this.wakePhrase && this.config.continuousMode ? 'wake' : 'capture';
		if ( !this.config.continuousMode ) {
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
		let recognition;
		try {
			recognition = new SpeechRecognitionCtor();
		} catch ( e ) {
			this.stop();
			this.handlers.onError( 'generic' );
			return;
		}

		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = this.languages[ this.langIndex ] || '';

		const isCurrent = () => this.enabled && this.recognition === recognition;
		recognition.onresult = ( event ) => {
			if ( isCurrent() ) {
				this.handleResult( event );
			}
		};
		recognition.onerror = ( event ) => {
			if ( isCurrent() ) {
				this.handleError( event );
			}
		};
		recognition.onend = () => {
			// Browsers stop recognition after silence; restart while enabled.
			if ( isCurrent() ) {
				try {
					recognition.start();
				} catch ( e ) {
					// Start can throw if called too quickly; retry shortly.
					clearTimeout( this.restartTimer );
					this.restartTimer = setTimeout( () => {
						this.restartTimer = null;
						if ( isCurrent() ) {
							try {
								recognition.start();
							} catch ( err ) {
								this.stop();
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
			this.stop();
			this.handlers.onError( 'generic' );
		}
	}

	/**
	 * @param {Object} event SpeechRecognition result event
	 */
	handleResult( event ) {
		if ( !this.enabled ) {
			return;
		}
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
			// Interim hypotheses may be revised (e.g. Wanda -> Rwanda). Only a
			// final result can wake the assistant or supply executable text.
			if ( finalText && this.matchesWakePhrase( finalText ) ) {
				const remainder = this.stripWakePhrase( finalText );
				this.handlers.onWake();
				this.stage = 'capture';
				this.handlers.onStateChange( 'capture' );
				// Wake phrase and command spoken in one breath.
				if ( remainder ) {
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
			const command = finalText.trim();
			if ( command ) {
				// Capture (including dictation/push-to-talk) is content, not wake
				// detection. A person's name or quoted wake word must survive.
				this.stage = 'processing';
				this.handlers.onCommand( command );
			}
		}
	}

	/**
	 * Find a leading, whole-word wake phrase using comparison-only normalisation.
	 * Never search inside a word or discard words before the wake phrase.
	 *
	 * @param {string} heard Original transcript
	 * @return {?number} End offset of the matched phrase, or null
	 */
	wakePhraseEnd( heard ) {
		if ( !this.wakeWords.length ) {
			return null;
		}
		const prefix = words( heard ).slice( 0, this.wakeWords.length );
		if ( prefix.length !== this.wakeWords.length ) {
			return null;
		}
		// Fuzziness must not reintroduce substring matches such as Rwanda or
		// Wandaville for Wanda, even though their edit distance may be small.
		if ( prefix.some( ( word, i ) => word.text !== this.wakeWords[ i ] &&
			word.text.includes( this.wakeWords[ i ] ) ) ) {
			return null;
		}
		const sensitivity = Number.isFinite( this.config.wakeSensitivity ) ?
			this.config.wakeSensitivity : 0.7;
		const threshold = Math.min( 1, Math.max( 0, sensitivity ) );
		const candidate = prefix.map( ( word ) => word.text ).join( ' ' );
		return similarity( candidate, this.wakePhrase ) >= threshold ?
			prefix[ prefix.length - 1 ].end : null;
	}

	/**
	 * @param {string} heard Original transcript
	 * @return {boolean}
	 */
	matchesWakePhrase( heard ) {
		return this.wakePhraseEnd( heard ) !== null;
	}

	/**
	 * Remove only a matched leading phrase and its speech punctuation separator.
	 * Slice the original text so command case, punctuation and spacing survive.
	 *
	 * @param {string} heard Original transcript
	 * @return {string}
	 */
	stripWakePhrase( heard ) {
		const end = this.wakePhraseEnd( heard );
		return end === null ? heard : heard.slice( end ).replace( /^[,.:;!?…]*\s*/, '' );
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
			// Fatal errors require an explicit retry, not an endless onend loop.
			this.stop();
			this.handlers.onError( event.error === 'network' ? 'network' : 'generic' );
		}
	}
}

module.exports = VoiceRecognition;
