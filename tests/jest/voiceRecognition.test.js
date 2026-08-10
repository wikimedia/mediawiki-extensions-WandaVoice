'use strict';

const VoiceRecognition = require( '../../resources/voiceRecognition.js' );

const noopHandlers = {
	onWake: () => {},
	onCommand: () => {},
	onInterim: () => {},
	onStateChange: () => {},
	onError: () => {}
};

function makeRecognizer( configOverrides ) {
	const config = Object.assign( {
		wakePhrase: 'wanda',
		wakeSensitivity: 0.7,
		continuousMode: true,
		language: 'en-US',
		fallbackLanguages: []
	}, configOverrides );
	return new VoiceRecognition( config, noopHandlers );
}

describe( 'VoiceRecognition.isSupported', () => {
	afterEach( () => {
		delete global.window.SpeechRecognition;
		delete global.window.webkitSpeechRecognition;
	} );

	it( 'is false without a SpeechRecognition implementation', () => {
		expect( VoiceRecognition.isSupported() ).toBe( false );
	} );

	it( 'detects the prefixed implementation', () => {
		global.window.webkitSpeechRecognition = function () {};
		expect( VoiceRecognition.isSupported() ).toBe( true );
	} );
} );

describe( 'wake phrase matching', () => {
	it( 'matches an exact wake word', () => {
		const recognizer = makeRecognizer();
		expect( recognizer.matchesWakePhrase( 'wanda' ) ).toBe( true );
	} );

	it( 'matches the wake word inside a longer utterance', () => {
		const recognizer = makeRecognizer();
		expect( recognizer.matchesWakePhrase( 'wanda navigate to main page' ) ).toBe( true );
	} );

	it( 'fuzzy-matches close mishearings at the default sensitivity', () => {
		const recognizer = makeRecognizer();
		// "wonda" vs "wanda": similarity 0.8 >= 0.7
		expect( recognizer.matchesWakePhrase( 'wonda open history' ) ).toBe( true );
	} );

	it( 'rejects distant words at the default sensitivity', () => {
		const recognizer = makeRecognizer();
		// "wander" vs "wanda": similarity ~0.67 < 0.7
		expect( recognizer.matchesWakePhrase( 'wander around' ) ).toBe( false );
	} );

	it( 'honours a strict sensitivity of 1', () => {
		const recognizer = makeRecognizer( { wakeSensitivity: 1 } );
		expect( recognizer.matchesWakePhrase( 'wonda' ) ).toBe( false );
		expect( recognizer.matchesWakePhrase( 'wanda' ) ).toBe( true );
	} );

	it( 'matches multi-word wake phrases in any window position', () => {
		const recognizer = makeRecognizer( { wakePhrase: 'hey wanda' } );
		expect( recognizer.matchesWakePhrase( 'okay hey wanda open history' ) ).toBe( true );
		expect( recognizer.matchesWakePhrase( 'nothing to see here' ) ).toBe( false );
	} );
} );

describe( 'stripWakePhrase', () => {
	it( 'returns the trailing command after an exact match', () => {
		const recognizer = makeRecognizer();
		expect( recognizer.stripWakePhrase( 'wanda search for cats' ) )
			.toBe( 'search for cats' );
	} );

	it( 'returns the trailing command after a fuzzy match', () => {
		const recognizer = makeRecognizer();
		expect( recognizer.stripWakePhrase( 'wonda search for cats' ) )
			.toBe( 'search for cats' );
	} );

	it( 'returns an empty string when only the wake word was heard', () => {
		const recognizer = makeRecognizer();
		expect( recognizer.stripWakePhrase( 'wanda' ) ).toBe( '' );
	} );

	it( 'strips multi-word wake phrases', () => {
		const recognizer = makeRecognizer( { wakePhrase: 'hey wanda' } );
		expect( recognizer.stripWakePhrase( 'hey wanda edit section 2' ) )
			.toBe( 'edit section 2' );
	} );
} );

function makeTracked( configOverrides ) {
	const events = { wakes: 0, commands: [], interims: [], states: [], errors: [] };
	const config = Object.assign( {
		wakePhrase: 'wanda',
		wakeSensitivity: 0.7,
		continuousMode: true,
		language: 'en-US',
		fallbackLanguages: []
	}, configOverrides );
	const recognizer = new VoiceRecognition( config, {
		onWake: () => events.wakes++,
		onCommand: ( text ) => events.commands.push( text ),
		onInterim: ( text ) => events.interims.push( text ),
		onStateChange: ( state ) => events.states.push( state ),
		onError: ( kind ) => events.errors.push( kind )
	} );
	return { recognizer, events };
}

function makeEvent( transcript, isFinal ) {
	return {
		resultIndex: 0,
		results: [ { isFinal: isFinal, 0: { transcript: transcript }, length: 1 } ]
	};
}

describe( 'result handling state machine', () => {
	it( 'handles the wake phrase and command spoken in one breath', () => {
		const { recognizer, events } = makeTracked();
		recognizer.enabled = true;
		recognizer.stage = 'wake';

		recognizer.handleResult( makeEvent( 'Wanda, navigate to Main Page', true ) );

		expect( events.wakes ).toBe( 1 );
		expect( events.commands ).toEqual( [ 'navigate to main page' ] );
		expect( recognizer.stage ).toBe( 'processing' );
	} );

	it( 'enters capture stage after the wake word alone', () => {
		const { recognizer, events } = makeTracked();
		recognizer.enabled = true;
		recognizer.stage = 'wake';

		recognizer.handleResult( makeEvent( 'wanda', true ) );

		expect( events.wakes ).toBe( 1 );
		expect( events.commands ).toEqual( [] );
		expect( recognizer.stage ).toBe( 'capture' );
	} );

	it( 'ignores unrelated speech in the wake stage', () => {
		const { recognizer, events } = makeTracked();
		recognizer.enabled = true;
		recognizer.stage = 'wake';

		recognizer.handleResult( makeEvent( 'talking about something else', true ) );

		expect( events.wakes ).toBe( 0 );
		expect( recognizer.stage ).toBe( 'wake' );
	} );

	it( 'reports interim transcripts and emits the final command in capture stage', () => {
		const { recognizer, events } = makeTracked();
		recognizer.enabled = true;
		recognizer.stage = 'capture';

		recognizer.handleResult( makeEvent( 'edit sec', false ) );
		expect( events.interims ).toEqual( [ 'edit sec' ] );

		recognizer.handleResult( makeEvent( 'edit section 2', true ) );
		expect( events.commands ).toEqual( [ 'edit section 2' ] );
		expect( recognizer.stage ).toBe( 'processing' );
	} );

	it( 'strips a leading wake word from a captured command', () => {
		const { recognizer, events } = makeTracked();
		recognizer.enabled = true;
		recognizer.stage = 'capture';

		recognizer.handleResult( makeEvent( 'Wanda save', true ) );
		expect( events.commands ).toEqual( [ 'save' ] );
	} );
} );

describe( 'error handling', () => {
	it( 'stops and reports mic-denied on permission errors', () => {
		const { recognizer, events } = makeTracked();
		recognizer.enabled = true;

		recognizer.handleError( { error: 'not-allowed' } );

		expect( events.errors ).toEqual( [ 'mic-denied' ] );
		expect( events.states ).toContain( 'off' );
		expect( recognizer.enabled ).toBe( false );
	} );

	it( 'ignores benign no-speech errors', () => {
		const { recognizer, events } = makeTracked();
		recognizer.handleError( { error: 'no-speech' } );
		expect( events.errors ).toEqual( [] );
	} );

	it( 'falls back to the next configured language when unsupported', () => {
		const { recognizer, events } = makeTracked( { fallbackLanguages: [ 'en-GB' ] } );
		recognizer.recognition = { lang: 'en-US' };

		recognizer.handleError( { error: 'language-not-supported' } );

		expect( recognizer.recognition.lang ).toBe( 'en-GB' );
		expect( events.errors ).toEqual( [] );
	} );
} );

describe( 'listening lifecycle', () => {
	let created;

	class FakeSpeechRecognition {
		constructor() {
			this.started = 0;
			this.stopped = 0;
			this.lang = '';
			created.push( this );
		}

		start() {
			this.started++;
		}

		stop() {
			this.stopped++;
		}
	}

	beforeEach( () => {
		created = [];
		global.window.SpeechRecognition = FakeSpeechRecognition;
	} );

	afterEach( () => {
		delete global.window.SpeechRecognition;
	} );

	it( 'starts in the wake stage when a wake phrase is configured', () => {
		const { recognizer, events } = makeTracked();
		recognizer.start();

		expect( recognizer.enabled ).toBe( true );
		expect( recognizer.stage ).toBe( 'wake' );
		expect( events.states ).toContain( 'wake' );
		expect( created ).toHaveLength( 1 );
		expect( created[ 0 ].started ).toBe( 1 );
		expect( created[ 0 ].continuous ).toBe( true );
		expect( created[ 0 ].interimResults ).toBe( true );
		expect( created[ 0 ].lang ).toBe( 'en-US' );
	} );

	it( 'starts directly in capture stage without a wake phrase', () => {
		const { recognizer } = makeTracked( { wakePhrase: '' } );
		recognizer.start();
		expect( recognizer.stage ).toBe( 'capture' );
	} );

	it( 'stop disables listening and reports the off state', () => {
		const { recognizer, events } = makeTracked();
		recognizer.start();
		recognizer.stop();

		expect( recognizer.enabled ).toBe( false );
		expect( created[ 0 ].stopped ).toBe( 1 );
		expect( events.states ).toContain( 'off' );
	} );

	it( 'captureNow switches to push-to-talk capture', () => {
		const { recognizer, events } = makeTracked();
		recognizer.start();
		recognizer.captureNow();
		expect( recognizer.stage ).toBe( 'capture' );
		expect( events.states ).toContain( 'capture' );
	} );

	it( 'resumeWake returns to wake listening in continuous mode', () => {
		const { recognizer } = makeTracked();
		recognizer.start();
		recognizer.captureNow();
		recognizer.resumeWake();
		expect( recognizer.stage ).toBe( 'wake' );
	} );

	it( 'resumeWake stops listening when continuous mode is off and no wake phrase is set', () => {
		const { recognizer } = makeTracked( { continuousMode: false, wakePhrase: '' } );
		recognizer.start();
		recognizer.resumeWake();
		expect( recognizer.enabled ).toBe( false );
	} );

	it( 'auto-restarts the recogniser when the browser ends it mid-session', () => {
		const { recognizer } = makeTracked();
		recognizer.start();

		created[ 0 ].onend();
		expect( created[ 0 ].started ).toBe( 2 );

		recognizer.stop();
		expect( created[ 0 ].onend ).toBeNull();
	} );
} );
