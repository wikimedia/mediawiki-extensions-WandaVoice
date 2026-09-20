/**
 * Initialization script for WandaVoice.
 *
 * Mounts the voice panel, wires the recognition -> processor -> executor
 * pipeline and resumes multi-step commands after navigation.
 */

const Vue = require( 'vue' );
window.defineComponent = window.defineComponent ||
	( Vue && Vue.defineComponent ) ||
	function ( obj ) {
		return obj;
	};
const VoicePanel = require( './components/VoicePanel.vue' );
const VoiceRecognition = require( './voiceRecognition.js' );
const ServerRecognition = require( './serverRecognition.js' );
const CommandProcessor = require( './commandProcessor.js' );
const CommandExecutor = require( './commandExecutor.js' );
const AudioFeedback = require( './audioFeedback.js' );

( function () {
	'use strict';

	// Remembers across navigations that the user turned listening on, so
	// hands-free sessions survive voice-initiated page loads (T410215).
	const LISTENING_KEY = 'wandavoice-listening';

	/**
	 * @param {boolean} on
	 */
	function setListeningFlag( on ) {
		try {
			if ( on ) {
				sessionStorage.setItem( LISTENING_KEY, '1' );
			} else {
				sessionStorage.removeItem( LISTENING_KEY );
			}
		} catch ( e ) {
			// Session storage unavailable; listening will not auto-resume.
		}
	}

	/**
	 * @return {boolean}
	 */
	function getListeningFlag() {
		try {
			return sessionStorage.getItem( LISTENING_KEY ) === '1';
		} catch ( e ) {
			return false;
		}
	}

	$( () => {
		const config = mw.config.get( 'wgWandaVoice' );
		if ( !config ) {
			return;
		}

		// Pick the recognition engine: the browser-native Web Speech API when
		// available, or MediaRecorder + server-side transcription as fallback
		// for browsers without it (e.g. Firefox), Phonos-style.
		const browserSupported = VoiceRecognition.isSupported();
		const serverSupported = ServerRecognition.isSupported() && !!config.serverSTT;
		let Engine = null;
		if ( config.recognitionEngine === 'browser' ) {
			Engine = browserSupported ? VoiceRecognition : null;
		} else if ( config.recognitionEngine === 'server' ) {
			Engine = serverSupported ? ServerRecognition : null;
		} else {
			Engine = browserSupported ? VoiceRecognition :
				( serverSupported ? ServerRecognition : null );
		}
		const supported = !!Engine;

		const container = document.createElement( 'div' );
		container.id = 'wandavoice-container';
		document.body.appendChild( container );

		const audio = new AudioFeedback( config );
		const processor = new CommandProcessor( config );

		let panel = null;
		let recognition = null;
		let commandGeneration = 0;

		const executor = new CommandExecutor( config, {
			onFeedback: ( text ) => {
				if ( text ) {
					panel.setFeedback( text );
					audio.speak( text );
				}
			},
			onError: ( text ) => {
				panel.setError( text );
				audio.earcon( 'error' );
				audio.speak( text );
			}
		} );

		/** Invalidate commands even when the engine stops itself (e.g. mic denial). */
		function cancelCommands() {
			commandGeneration++;
			processor.cancel();
		}

		/** Explicit stop/cancel also discards any unconsumed navigation plan. */
		function stopListening() {
			cancelCommands();
			executor.takePendingActions();
			setListeningFlag( false );
			audio.stopSpeaking();
			if ( recognition ) {
				recognition.stop();
			}
		}

		/**
		 * Run a processed command result: execute actions and handle
		 * listening-control actions locally.
		 *
		 * @param {Object} result { intent, actions, audioFeedback, thinkingSteps }
		 */
		async function runResult( result ) {
			panel.setThinking( result.thinkingSteps );

			if ( !result.actions.length ) {
				panel.setError( result.audioFeedback ||
					mw.message( 'wandavoice-error-unknown' ).text() );
				audio.earcon( 'error' );
				audio.speak( result.audioFeedback );
				return;
			}

			const controls = [];
			const executable = [];
			result.actions.forEach( ( action ) => {
				if ( action.type === 'stop_listening' || action.type === 'cancel' ||
					action.type === 'help' || action.type === 'start_dictation' ||
					action.type === 'stop_dictation'
				) {
					controls.push( action );
				} else {
					executable.push( action );
				}
			} );

			for ( const action of controls ) {
				if ( action.type === 'stop_listening' || action.type === 'cancel' ) {
					stopListening();
					if ( action.feedback ) {
						panel.setFeedback( action.feedback );
						audio.speak( action.feedback );
					}
					return;
				}
				if ( action.type === 'help' ) {
					panel.helpVisible = true;
					panel.expanded = true;
				}
				if ( action.feedback ) {
					panel.setFeedback( action.feedback );
					audio.speak( action.feedback );
				}
			}

			await executor.executeActions( executable );
		}

		/**
		 * Handle a final transcript captured by the recognizer.
		 *
		 * @param {string} transcript
		 */
		async function handleCommand( transcript ) {
			if ( !recognition || !recognition.enabled ) {
				return;
			}
			const generation = commandGeneration;
			const isCurrent = () => generation === commandGeneration && recognition.enabled;
			panel.setState( 'processing' );
			panel.setTranscript( transcript );
			audio.stopSpeaking();
			audio.earcon( 'stop' );
			audio.vibrate();

			try {
				const result = await processor.process( transcript );
				if ( !isCurrent() || !result ) {
					return;
				}
				await runResult( result );
			} catch ( e ) {
				if ( !isCurrent() ) {
					return;
				}
				panel.setError( mw.message( 'wandavoice-error-generic' ).text() );
				audio.earcon( 'error' );
			}

			if ( !isCurrent() ) {
				return;
			}
			if ( processor.dictationMode ) {
				recognition.captureNow();
				panel.setState( 'dictation' );
			} else {
				recognition.resumeWake();
			}
		}

		const panelApp = Vue.createMwApp( VoicePanel, {
			showThinking: !!config.showThinking,
			visualIndicators: config.visualIndicators !== false,
			unsupported: !supported,
			wakePhrase: config.wakePhrase || '',
			onToggleListening: () => {
				if ( !supported ) {
					if ( panel ) {
						panel.setError( mw.message( 'wandavoice-error-nosupport' ).text() );
					}
					return;
				}
				if ( recognition && recognition.enabled ) {
					stopListening();
					audio.speak( mw.message( 'wandavoice-feedback-listening-off' ).text() );
				} else if ( recognition ) {
					recognition.start();
					setListeningFlag( recognition.enabled );
					if ( recognition.enabled ) {
						audio.speak( mw.message( 'wandavoice-feedback-listening-on' ).text() );
					}
				}
			},
			onPushToTalk: () => {
				audio.earcon( 'wake' );
				audio.vibrate();
				if ( recognition ) {
					recognition.captureNow();
				}
			}
		} );
		panel = panelApp.mount( container );

		if ( Engine ) {
			recognition = new Engine( config, {
				onWake: () => {
					audio.earcon( 'wake' );
					audio.vibrate();
					panel.setFeedback( mw.message( 'wandavoice-feedback-wake' ).text() );
				},
				onCommand: handleCommand,
				onInterim: ( text ) => panel.setTranscript( text ),
				onStateChange: ( state ) => {
					if ( state === 'off' ) {
						cancelCommands();
						setListeningFlag( false );
					}
					panel.setState( state );
				},
				onError: ( kind ) => {
					if ( kind === 'mic-denied' ) {
						// Do not retry on every page load once permission is denied.
						setListeningFlag( false );
					}
					const errorMessage = kind === 'network' ?
						mw.message( 'wandavoice-error-network' ).text() :
						mw.message( kind === 'mic-denied' ?
							'wandavoice-error-mic-denied' : 'wandavoice-error-generic' ).text();
					panel.setError( errorMessage );
					audio.earcon( 'error' );
				}
			} );
		}

		if ( !supported ) {
			panel.setError( mw.message( 'wandavoice-error-nosupport' ).text() );
		}

		// Auto-resume a hands-free session started on a previous page. Browsers
		// that granted microphone permission allow starting recognition without
		// a new user gesture; failures surface through the error handler.
		if ( supported && getListeningFlag() ) {
			recognition.start();
		}

		// Resume a multi-step command that navigated to this page.
		const pending = executor.takePendingActions();
		if ( pending.length ) {
			const generation = commandGeneration;
			panel.setState( 'processing' );
			executor.executeActions( pending ).then( () => {
				if ( generation !== commandGeneration ) {
					return;
				}
				if ( recognition && recognition.enabled ) {
					recognition.resumeWake();
				} else {
					panel.setState( 'off' );
					if ( supported && config.continuousMode ) {
						// Listening could not auto-restart; announce readiness.
						panel.setFeedback( mw.message( 'wandavoice-feedback-resume' ).text() );
					}
				}
			} );
		}

		document.body.classList.add( 'wandavoice-active' );
	} );
}() );

window.WandaVoice = {
	CommandProcessor: CommandProcessor,
	CommandExecutor: CommandExecutor
};

module.exports = window.WandaVoice;
