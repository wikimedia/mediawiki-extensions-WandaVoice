/**
 * Audio and haptic feedback for WandaVoice.
 *
 * Uses the browser SpeechSynthesis API to speak confirmations (screen reader
 * friendly announcements are handled separately by the panel's live region)
 * and short WebAudio earcons for recording state transitions.
 */

class AudioFeedback {
	/**
	 * @param {Object} config wgWandaVoice configuration object
	 */
	constructor( config ) {
		this.config = config;
		this.audioContext = null;
	}

	/**
	 * Speak a confirmation sentence.
	 *
	 * @param {string} text
	 */
	speak( text ) {
		if ( !this.config.audioFeedback || !text || !window.speechSynthesis ) {
			return;
		}
		window.speechSynthesis.cancel();
		const utterance = new SpeechSynthesisUtterance( text );
		if ( this.config.language ) {
			utterance.lang = this.config.language;
		}
		window.speechSynthesis.speak( utterance );
	}

	/** Stop any in-progress speech (before capturing a command). */
	stopSpeaking() {
		if ( window.speechSynthesis ) {
			window.speechSynthesis.cancel();
		}
	}

	/**
	 * Play a short earcon.
	 *
	 * @param {string} kind 'wake' (rising), 'stop' (falling) or 'error' (buzz)
	 */
	earcon( kind ) {
		if ( !this.config.audioFeedback ) {
			return;
		}
		try {
			if ( !this.audioContext ) {
				const Ctor = window.AudioContext || window.webkitAudioContext;
				if ( !Ctor ) {
					return;
				}
				this.audioContext = new Ctor();
			}
			const ctx = this.audioContext;
			const oscillator = ctx.createOscillator();
			const gain = ctx.createGain();
			oscillator.connect( gain );
			gain.connect( ctx.destination );
			gain.gain.setValueAtTime( 0.08, ctx.currentTime );
			gain.gain.exponentialRampToValueAtTime( 0.001, ctx.currentTime + 0.25 );

			if ( kind === 'wake' ) {
				oscillator.frequency.setValueAtTime( 520, ctx.currentTime );
				oscillator.frequency.linearRampToValueAtTime( 780, ctx.currentTime + 0.15 );
			} else if ( kind === 'stop' ) {
				oscillator.frequency.setValueAtTime( 780, ctx.currentTime );
				oscillator.frequency.linearRampToValueAtTime( 520, ctx.currentTime + 0.15 );
			} else {
				oscillator.type = 'square';
				oscillator.frequency.setValueAtTime( 180, ctx.currentTime );
			}

			oscillator.start( ctx.currentTime );
			oscillator.stop( ctx.currentTime + 0.25 );
		} catch ( e ) {
			// Audio feedback is best-effort only.
		}
	}

	/** Vibrate briefly on supported (mobile) devices. */
	vibrate() {
		if ( this.config.hapticFeedback && navigator.vibrate ) {
			navigator.vibrate( 40 );
		}
	}
}

module.exports = AudioFeedback;
