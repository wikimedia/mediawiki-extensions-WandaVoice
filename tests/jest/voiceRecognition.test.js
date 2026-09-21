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

	it( 'matches the leading wake word in a longer utterance', () => {
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

	it( 'matches multi-word wake phrases only at the beginning', () => {
		const recognizer = makeRecognizer( { wakePhrase: 'hey wanda' } );
		expect( recognizer.matchesWakePhrase( 'hey wanda open history' ) ).toBe( true );
		expect( recognizer.matchesWakePhrase( 'okay hey wanda open history' ) ).toBe( false );
		expect( recognizer.matchesWakePhrase( 'nothing to see here' ) ).toBe( false );
	} );

	describe.each( [ undefined, 0.7, 1 ] )( 'whole-word boundaries at sensitivity %s', ( wakeSensitivity ) => {
		it.each( [ 'Rwanda', 'Wandas', 'Wandaville', 'preWanda', 'Wanda123' ] )(
			'rejects the embedded wake word in %s', ( word ) => {
				const recognizer = makeRecognizer( { wakeSensitivity } );
				const heard = word + ', Type Keep Case!';

				expect( recognizer.matchesWakePhrase( heard ) ).toBe( false );
				expect( recognizer.wakePhraseEnd( heard ) ).toBeNull();
				expect( recognizer.stripWakePhrase( heard ) ).toBe( heard );
			}
		);
	} );

	it.each( [
		[ 'wanda', 'We discussed Wanda, Type Hello!' ],
		[ 'wanda', 'Please ask Wonda for help' ],
		[ 'hey wanda', 'Okay, hey Wanda: save' ],
		[ 'hey wanda', 'Hey Rwanda: save' ],
		[ 'hey wanda', 'Heys Wanda: save' ],
		[ 'hey wanda', 'Hey' ],
		[ 'wanda', '' ],
		[ 'wanda', ' ,:!?…\n' ]
	] )( 'rejects a nonleading or incomplete %s in %j', ( wakePhrase, heard ) => {
		const recognizer = makeRecognizer( { wakePhrase } );

		expect( recognizer.matchesWakePhrase( heard ) ).toBe( false );
		expect( recognizer.wakePhraseEnd( heard ) ).toBeNull();
		expect( recognizer.stripWakePhrase( heard ) ).toBe( heard );
	} );

	it.each( [
		[ undefined, true ], [ NaN, true ], [ 0.7, true ],
		[ 0.8, true ], [ 0.81, false ], [ 1, false ]
	] )( 'matches mixed-case Wonda according to sensitivity %s', ( wakeSensitivity, expected ) => {
		const recognizer = makeRecognizer( { wakePhrase: 'WaNdA', wakeSensitivity } );

		expect( recognizer.matchesWakePhrase( 'WoNdA: Type NASA!' ) ).toBe( expected );
	} );

	it.each( [ '', ' \t\n', ',:;!?…', null, undefined ] )(
		'treats a wordless configuration %j as no wake phrase', ( wakePhrase ) => {
			const recognizer = makeRecognizer( { wakePhrase } );
			const heard = '  Wanda, Keep This!\n';

			expect( recognizer.matchesWakePhrase( heard ) ).toBe( false );
			expect( recognizer.wakePhraseEnd( heard ) ).toBeNull();
			expect( recognizer.stripWakePhrase( heard ) ).toBe( heard );
		}
	);
} );

describe( 'wakePhraseEnd original UTF-16 offsets', () => {
	it.each( [
		[ 'WaNdA', '  WANDA: Type NASA!', 7 ],
		[ 'wánda', '😀 WA\u0301NDA: École!', 9 ],
		[ 'WA\u0301NDA', 'Wánda: École!', 5 ],
		[ 'école', '\tE\u0301COLE: Bonjour!', 7 ],
		[ 'i\u0307', 'İ: Keep Case!', 1 ],
		[ '𐐨', '😀 𐐀: Keep Case!', 5 ],
		[ '你好', '你好: 世界!', 2 ],
		[ 'hey wánda', '😀 HEY,\nWA\u0301NDA: Type NASA!', 14 ],
		[ 'HEY, Wanda!', 'hey—WANDA: Type NASA!', 9 ]
	] )( 'normalizes %j against %j without changing the end offset', ( wakePhrase, heard, end ) => {
		const recognizer = makeRecognizer( { wakePhrase, wakeSensitivity: 1 } );

		expect( recognizer.matchesWakePhrase( heard ) ).toBe( true );
		expect( recognizer.wakePhraseEnd( heard ) ).toBe( end );
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

	it.each( [
		[ 'wanda', 'WaNdA, Type NASA!', 'Type NASA!' ],
		[ 'wanda', 'WoNdA: Type Hello, NASA!', 'Type Hello, NASA!' ],
		[ 'wanda', 'WANDA,.:;!?…\t\nType [[Main Page|NASA]]!', 'Type [[Main Page|NASA]]!' ],
		[ 'wanda', 'Wanda: Type https://Example.org/Path?Q=NASA#Top!', 'Type https://Example.org/Path?Q=NASA#Top!' ],
		[ 'wanda', 'Wanda, Type 你好  Café\n\n日本語!  ', 'Type 你好  Café\n\n日本語!  ' ],
		[ 'wánda', '😀 WA\u0301NDA: Type E\u0301cole!', 'Type E\u0301cole!' ],
		[ 'WA\u0301NDA', 'WÁNDA: Type École!', 'Type École!' ],
		[ 'hey wanda', 'HEY,\nWANDA: Type Hello!', 'Type Hello!' ],
		[ 'hey, wanda!', 'Hey—Wanda! Type Hello!', 'Type Hello!' ],
		[ 'wanda', 'Wanda: Wanda, Tell Wonda About Rwanda!', 'Wanda, Tell Wonda About Rwanda!' ],
		[ 'wanda', 'Wanda, \n: Keep This!', ': Keep This!' ],
		[ 'wanda', 'Wanda "Quoted Text!"', '"Quoted Text!"' ],
		[ 'wanda', 'Wanda—Keep This!', '—Keep This!' ],
		[ 'wanda', 'Wanda,:;.!?… \n', '' ],
		[ 'hey wanda', 'HEY, WANDA!\n', '' ]
	] )( 'strips only the leading %j and adjacent separators from %j', ( wakePhrase, heard, expected ) => {
		const recognizer = makeRecognizer( { wakePhrase } );

		const command = recognizer.stripWakePhrase( heard );

		expect( command ).toBe( expected );
	} );

	it.each( [
		'  Rwanda, Type Hello!\n',
		'We asked Wanda: Type https://Example.org/Path?Q=NASA!',
		'  你好  E\u0301cole\n日本語!  '
	] )( 'returns unmatched input byte-for-byte unchanged: %j', ( heard ) => {
		const recognizer = makeRecognizer();

		expect( recognizer.stripWakePhrase( heard ) ).toBe( heard );
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
		expect( events.commands ).toEqual( [ 'navigate to Main Page' ] );
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

	it.each( [
		[ 'Wanda save', 'Wanda save' ],
		[ '  Rwanda, NASA!\n', 'Rwanda, NASA!' ],
		[ 'WoNdA: https://Example.org/Path?Q=NASA!', 'WoNdA: https://Example.org/Path?Q=NASA!' ],
		[ '\tWanda, 你好  E\u0301cole\nWanda!  ', 'Wanda, 你好  E\u0301cole\nWanda!' ],
		[ 'Wanda', 'Wanda' ],
		[ '!?', '!?' ]
	] )( 'preserves captured content apart from outer whitespace: %j', ( heard, expected ) => {
		const { recognizer, events } = makeTracked();
		recognizer.enabled = true;
		recognizer.stage = 'capture';

		recognizer.handleResult( makeEvent( heard, true ) );

		expect( events.commands ).toEqual( [ expected ] );
		expect( events.wakes ).toBe( 0 );
		expect( recognizer.stage ).toBe( 'processing' );
	} );

	it.each( [ '', ' \t\n' ] )( 'keeps capturing when a final result is empty after trimming: %j', ( heard ) => {
		const { recognizer, events } = makeTracked();
		recognizer.enabled = true;
		recognizer.stage = 'capture';

		recognizer.handleResult( makeEvent( heard, true ) );

		expect( events.commands ).toEqual( [] );
		expect( recognizer.stage ).toBe( 'capture' );
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

	it.each( [ '', ' \t\n', ',:!?…' ] )( 'starts directly in capture stage with wordless wake phrase %j', ( wakePhrase ) => {
		const { recognizer } = makeTracked( { wakePhrase } );
		recognizer.start();
		expect( recognizer.stage ).toBe( 'capture' );
	} );

	it( 'stop disables listening and reports the off state', () => {
		const { recognizer, events } = makeTracked();
		recognizer.start();
		recognizer.stop();

		expect( recognizer.enabled ).toBe( false );
		expect( recognizer.stage ).toBe( 'off' );
		expect( recognizer.recognition ).toBeNull();
		expect( created[ 0 ].onresult ).toBeNull();
		expect( created[ 0 ].onerror ).toBeNull();
		expect( created[ 0 ].onend ).toBeNull();
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

	describe( 'final-only wake and raw capture regressions', () => {
		it( 'uses only new final text, not interim hypotheses or earlier result history', () => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const current = created[ 0 ];
			const unrelated = makeEvent( 'Rwanda, Type Wrong!', true ).results[ 0 ];
			const interim = makeEvent( 'Wanda, Type Premature!', false ).results[ 0 ];

			current.onresult( { resultIndex: 0, results: [ unrelated, interim ] } );
			expect( events.wakes ).toBe( 0 );
			expect( events.commands ).toEqual( [] );
			expect( recognizer.stage ).toBe( 'wake' );
			// Web Speech retains previous results; resultIndex marks the first changed one.
			current.onresult( {
				resultIndex: 1,
				results: [ unrelated, makeEvent( 'Wanda: Type Final!', true ).results[ 0 ], interim ]
			} );

			expect( events.wakes ).toBe( 1 );
			expect( events.commands ).toEqual( [ 'Type Final!' ] );
			expect( events.interims ).toEqual( [] );
			expect( recognizer.stage ).toBe( 'processing' );
		} );

		it.each( [
			'Rwanda, Type Hello!', 'Wandas, Type Hello!', 'Wandaville, Type Hello!',
			'We asked Wanda to Type Hello!', 'Unrelated conversation'
		] )( 'ignores repeated wake hypotheses revised to %j', ( finalText ) => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const current = created[ 0 ];

			for ( const interim of [ 'Wanda', 'Wanda, Type', 'Wanda, Type Hello!' ] ) {
				current.onresult( makeEvent( interim, false ) );
				expect( recognizer.stage ).toBe( 'wake' );
				expect( events ).toEqual( {
					wakes: 0, commands: [], interims: [], states: [ 'wake' ], errors: []
				} );
			}
			current.onresult( makeEvent( finalText, true ) );

			expect( recognizer.stage ).toBe( 'wake' );
			expect( events ).toEqual( {
				wakes: 0, commands: [], interims: [], states: [ 'wake' ], errors: []
			} );
		} );

		it.each( [ 'Wanda', 'WoNdA' ] )( 'emits only the final command after repeated %s hypotheses', ( wake ) => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const current = created[ 0 ];
			const finalText = wake + ': Type Wanda, NASA!';

			for ( const text of [ wake, wake + ': Type', finalText, finalText ] ) {
				current.onresult( makeEvent( text, false ) );
			}
			expect( recognizer.stage ).toBe( 'wake' );
			expect( events.commands ).toEqual( [] );
			expect( events.wakes ).toBe( 0 );
			current.onresult( makeEvent( finalText, true ) );
			// Further results while the command is processing cannot duplicate execution.
			current.onresult( makeEvent( finalText, false ) );
			current.onresult( makeEvent( finalText, true ) );

			expect( events.wakes ).toBe( 1 );
			expect( events.commands ).toEqual( [ 'Type Wanda, NASA!' ] );
			expect( events.interims ).toEqual( [] );
			expect( events.states ).toEqual( [ 'wake', 'capture' ] );
			expect( recognizer.stage ).toBe( 'processing' );
		} );

		it.each( [ 'Wanda', 'Rwanda' ] )( 'captures %s as content after a punctuation-only wake remainder', ( name ) => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const current = created[ 0 ];
			const content = name + ',  NASA!\n你好';

			current.onresult( makeEvent( 'Wanda,!?…\n', true ) );
			expect( recognizer.stage ).toBe( 'capture' );
			expect( events.wakes ).toBe( 1 );
			expect( events.commands ).toEqual( [] );
			current.onresult( makeEvent( content, false ) );
			current.onresult( makeEvent( '  ' + content + '\n', true ) );

			expect( events.interims ).toEqual( [ content ] );
			expect( events.commands ).toEqual( [ content ] );
			expect( events.wakes ).toBe( 1 );
			expect( recognizer.stage ).toBe( 'processing' );
		} );

		it.each( [
			'Wanda, Type NASA!', 'Rwanda: Beautiful!',
			'WoNdA: https://Example.org/Path?Q=NASA!', 'Wanda, 你好  E\u0301cole\nWanda!'
		] )( 'preserves push-to-talk content %j despite a configured wake phrase', ( content ) => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			recognizer.captureNow();

			created[ 0 ].onresult( makeEvent( content, false ) );
			created[ 0 ].onresult( makeEvent( '\t' + content + '  ', true ) );

			expect( events.interims ).toEqual( [ content ] );
			expect( events.commands ).toEqual( [ content ] );
			expect( events.wakes ).toBe( 0 );
			expect( recognizer.stage ).toBe( 'processing' );
		} );

		it( 'does not leak a pending wake hypothesis through stop and restart', () => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const queuedResult = created[ 0 ].onresult;
			queuedResult( makeEvent( 'Wanda, Type Stale!', false ) );
			recognizer.stop();
			recognizer.start();

			queuedResult( makeEvent( 'Wanda, Type Stale!', true ) );
			created[ 1 ].onresult( makeEvent( 'Rwanda, Type Unrelated!', true ) );
			expect( recognizer.stage ).toBe( 'wake' );
			expect( events.wakes ).toBe( 0 );
			expect( events.commands ).toEqual( [] );
			created[ 1 ].onresult( makeEvent( 'Wanda: Type Current!', true ) );

			expect( events.wakes ).toBe( 1 );
			expect( events.commands ).toEqual( [ 'Type Current!' ] );
			expect( events.interims ).toEqual( [] );
			expect( events.states ).toEqual( [ 'wake', 'off', 'wake', 'capture' ] );
			expect( recognizer.stage ).toBe( 'processing' );
		} );
	} );

	describe( 'fatal error usability regressions', () => {
		beforeEach( () => {
			jest.useFakeTimers();
		} );

		afterEach( () => {
			jest.restoreAllMocks();
			jest.useRealTimers();
		} );

		it.each( [
			[ 'network', 'network' ],
			[ 'audio-capture', 'generic' ],
			[ 'unexpected-browser-error', 'generic' ],
			[ 'language-not-supported', 'generic' ]
		] )( 'stops on fatal %s and never restarts from a queued end event', ( error, expected ) => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const current = created[ 0 ];
			const queuedEnd = current.onend;

			current.onerror( { error } );
			queuedEnd();
			jest.advanceTimersByTime( 1000 );

			expect( events.errors ).toEqual( [ expected ] );
			expect( events.states ).toEqual( [ 'wake', 'off' ] );
			expect( recognizer.enabled ).toBe( false );
			expect( recognizer.stage ).toBe( 'off' );
			expect( recognizer.recognition ).toBeNull();
			expect( [ current.onresult, current.onerror, current.onend ] )
				.toEqual( [ null, null, null ] );
			expect( current.stopped ).toBe( 1 );
			expect( current.started ).toBe( 1 );
			expect( recognizer.restartTimer ).toBeNull();
			expect( jest.getTimerCount() ).toBe( 0 );
		} );

		it( 'stops only after all configured language fallbacks are exhausted', () => {
			const { recognizer, events } = makeTracked( { fallbackLanguages: [ 'en-GB', 'fr' ] } );
			recognizer.start();
			const current = created[ 0 ];
			const queuedEnd = current.onend;

			for ( const language of [ 'en-GB', 'fr' ] ) {
				current.onerror( { error: 'language-not-supported' } );
				expect( current.lang ).toBe( language );
				expect( recognizer.enabled ).toBe( true );
				expect( events.errors ).toEqual( [] );
			}
			current.onerror( { error: 'language-not-supported' } );
			queuedEnd();
			jest.advanceTimersByTime( 1000 );

			expect( recognizer.enabled ).toBe( false );
			expect( recognizer.stage ).toBe( 'off' );
			expect( events.states ).toEqual( [ 'wake', 'off' ] );
			expect( events.errors ).toEqual( [ 'generic' ] );
			expect( current.started ).toBe( 1 );
			expect( current.stopped ).toBe( 1 );
			expect( jest.getTimerCount() ).toBe( 0 );
		} );

		it( 'cancels an already scheduled restart when a fatal network error arrives', () => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const current = created[ 0 ];
			const start = jest.spyOn( current, 'start' ).mockImplementation( () => {
				throw new Error( 'busy' );
			} );
			current.onend();
			expect( jest.getTimerCount() ).toBe( 1 );

			current.onerror( { error: 'network' } );
			jest.advanceTimersByTime( 1000 );

			expect( recognizer.enabled ).toBe( false );
			expect( recognizer.restartTimer ).toBeNull();
			expect( jest.getTimerCount() ).toBe( 0 );
			expect( start ).toHaveBeenCalledTimes( 1 );
			expect( events.errors ).toEqual( [ 'network' ] );
		} );

		it( 'accepts a command on an explicit retry after a fatal network error', () => {
			const { recognizer, events } = makeTracked( { wakePhrase: '' } );
			recognizer.start();
			created[ 0 ].onerror( { error: 'network' } );
			expect( recognizer.enabled ).toBe( false );

			recognizer.start();
			created[ 1 ].onresult( makeEvent( 'save', true ) );

			expect( created ).toHaveLength( 2 );
			expect( created[ 1 ].started ).toBe( 1 );
			expect( recognizer.enabled ).toBe( true );
			expect( recognizer.stage ).toBe( 'processing' );
			expect( events.states ).toEqual( [ 'capture', 'off', 'capture' ] );
			expect( events.commands ).toEqual( [ 'save' ] );
			expect( events.errors ).toEqual( [ 'network' ] );
		} );

		it.each( [ 'constructor', 'start' ] )( 'stops without announcing active state when %s throws', ( failure ) => {
			const { recognizer, events } = makeTracked();
			if ( failure === 'constructor' ) {
				global.window.SpeechRecognition = jest.fn( () => {
					throw new Error( 'unavailable' );
				} );
			} else {
				jest.spyOn( FakeSpeechRecognition.prototype, 'start' ).mockImplementation( () => {
					throw new Error( 'cannot start' );
				} );
			}

			expect( () => recognizer.start() ).not.toThrow();
			jest.advanceTimersByTime( 1000 );

			expect( recognizer.enabled ).toBe( false );
			expect( recognizer.stage ).toBe( 'off' );
			expect( recognizer.recognition ).toBeNull();
			expect( events.states ).toEqual( [ 'off' ] );
			expect( events.errors ).toEqual( [ 'generic' ] );
			expect( jest.getTimerCount() ).toBe( 0 );
		} );

		it( 'stops when the delayed restart also throws instead of retrying indefinitely', () => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const current = created[ 0 ];
			const queuedEnd = current.onend;
			const start = jest.spyOn( current, 'start' ).mockImplementation( () => {
				throw new Error( 'cannot restart' );
			} );

			queuedEnd();
			expect( recognizer.enabled ).toBe( true );
			jest.advanceTimersByTime( 250 );
			queuedEnd();
			jest.advanceTimersByTime( 1000 );

			expect( start ).toHaveBeenCalledTimes( 2 );
			expect( recognizer.enabled ).toBe( false );
			expect( recognizer.stage ).toBe( 'off' );
			expect( recognizer.recognition ).toBeNull();
			expect( current.stopped ).toBe( 1 );
			expect( events.states ).toEqual( [ 'wake', 'off' ] );
			expect( events.errors ).toEqual( [ 'generic' ] );
			expect( recognizer.restartTimer ).toBeNull();
			expect( jest.getTimerCount() ).toBe( 0 );
		} );

		it( 'stops after a command in noncontinuous mode even with a wake phrase configured', () => {
			const { recognizer, events } = makeTracked( { continuousMode: false } );
			recognizer.start();
			// Push-to-talk deliberately bypasses wake matching, which is outside this regression.
			recognizer.captureNow();
			const current = created[ 0 ];
			const queuedEnd = current.onend;
			current.onresult( makeEvent( 'save', true ) );
			expect( recognizer.stage ).toBe( 'processing' );

			recognizer.resumeWake();
			queuedEnd();
			jest.advanceTimersByTime( 1000 );

			expect( events.commands ).toEqual( [ 'save' ] );
			expect( recognizer.enabled ).toBe( false );
			expect( recognizer.stage ).toBe( 'off' );
			expect( events.states ).toEqual( [ 'wake', 'capture', 'off' ] );
			expect( current.stopped ).toBe( 1 );
			expect( current.started ).toBe( 1 );
			expect( jest.getTimerCount() ).toBe( 0 );
		} );
	} );

	describe( 'cancellation regressions', () => {
		beforeEach( () => {
			jest.useFakeTimers();
		} );

		afterEach( () => {
			jest.restoreAllMocks();
			jest.useRealTimers();
		} );

		describe.each( [ false, true ] )( 'restart = %s', ( restart ) => {
			it.each( [
				[ 'final', '' ], [ 'interim', '' ],
				[ 'wake-final', 'wanda' ], [ 'wake-interim', 'wanda' ],
				[ 'permission', 'wanda' ], [ 'generic', 'wanda' ],
				[ 'language', 'wanda' ], [ 'end', 'wanda' ]
			] )(
				'ignores a queued %s callback from the stopped instance', ( kind, wakePhrase ) => {
					const { recognizer, events } = makeTracked( {
						wakePhrase, fallbackLanguages: [ 'fr' ]
					} );
					recognizer.start();
					const old = created[ 0 ];
					// Save callbacks before detaching: the browser may already have queued them.
					const callbacks = { result: old.onresult, error: old.onerror, end: old.onend };
					recognizer.stop();
					if ( restart ) {
						recognizer.start();
					}
					const states = events.states.slice();
					const current = recognizer.recognition;

					if ( kind.endsWith( 'final' ) || kind.endsWith( 'interim' ) ) {
						callbacks.result( makeEvent( 'wanda save', kind.endsWith( 'final' ) ) );
					} else if ( kind === 'end' ) {
						callbacks.end();
					} else {
						callbacks.error( { error: {
							permission: 'not-allowed', generic: 'network', language: 'language-not-supported'
						}[ kind ] } );
					}
					jest.advanceTimersByTime( 1000 );

					expect( events ).toEqual( {
						wakes: 0, commands: [], interims: [], states, errors: []
					} );
					expect( recognizer.enabled ).toBe( restart );
					const initialStage = wakePhrase ? 'wake' : 'capture';
					expect( recognizer.stage ).toBe( restart ? initialStage : 'off' );
					expect( recognizer.recognition ).toBe( current );
					expect( recognizer.langIndex ).toBe( 0 );
					expect( old.started ).toBe( 1 );
					expect( jest.getTimerCount() ).toBe( 0 );
				}
			);

			it( 'clears delayed restarts and ignores an already queued retry', () => {
				const { recognizer, events } = makeTracked();
				recognizer.start();
				const old = created[ 0 ];
				const start = jest.spyOn( old, 'start' ).mockImplementation( () => {
					throw new Error( 'busy' );
				} );
				const timeout = jest.spyOn( global, 'setTimeout' );
				old.onend();
				const retry = timeout.mock.calls[ 0 ][ 0 ];
				expect( recognizer.restartTimer ).not.toBeNull();
				expect( jest.getTimerCount() ).toBe( 1 );

				recognizer.stop();
				expect( recognizer.restartTimer ).toBeNull();
				expect( jest.getTimerCount() ).toBe( 0 );
				if ( restart ) {
					recognizer.start();
				}
				const states = events.states.slice();
				jest.advanceTimersByTime( 1000 );
				retry();

				expect( start ).toHaveBeenCalledTimes( 1 );
				expect( events.errors ).toEqual( [] );
				expect( events.states ).toEqual( states );
				expect( recognizer.enabled ).toBe( restart );
			} );
		} );

		it.each( [ false, true ] )( 'invalidates before synchronous abort results (throws = %s)', ( throws ) => {
			const { recognizer, events } = makeTracked( { wakePhrase: '' } );
			recognizer.start();
			const old = created[ 0 ];
			const result = old.onresult;
			let atAbort;
			old.abort = jest.fn( () => {
				// Assert outside abort: stop intentionally catches exceptions from this callback.
				atAbort = {
					enabled: recognizer.enabled, stage: recognizer.stage,
					recognition: recognizer.recognition,
					callbacks: [ old.onresult, old.onerror, old.onend ]
				};
				result( makeEvent( 'save', true ) );
				if ( throws ) {
					throw new Error( 'already aborted' );
				}
			} );

			recognizer.stop();

			expect( atAbort ).toEqual( {
				enabled: false, stage: 'off', recognition: null, callbacks: [ null, null, null ]
			} );
			expect( old.abort ).toHaveBeenCalledTimes( 1 );
			expect( old.stopped ).toBe( 0 );
			expect( events.commands ).toEqual( [] );
			expect( events.errors ).toEqual( [] );
			expect( events.states ).toEqual( [ 'capture', 'off' ] );
		} );

		it( 'does not enter capture while disabled', () => {
			const { recognizer, events } = makeTracked();
			recognizer.captureNow();
			expect( recognizer.stage ).toBe( 'wake' );
			expect( events.states ).toEqual( [] );
			recognizer.start();
			recognizer.stop();

			recognizer.captureNow();

			expect( recognizer.stage ).toBe( 'off' );
			expect( recognizer.enabled ).toBe( false );
			expect( events.states ).toEqual( [ 'wake', 'off' ] );
			expect( created ).toHaveLength( 1 );
		} );

		it( 'delivers current interim and final results after restarting', () => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			recognizer.stop();
			recognizer.start();
			recognizer.captureNow();

			created[ 1 ].onresult( makeEvent( 'search for', false ) );
			created[ 1 ].onresult( makeEvent( 'search for cats', true ) );

			expect( events.interims ).toEqual( [ 'search for' ] );
			expect( events.commands ).toEqual( [ 'search for cats' ] );
			expect( recognizer.stage ).toBe( 'processing' );
		} );

		it( 'runs a delayed restart while the session is still current', () => {
			const { recognizer, events } = makeTracked();
			recognizer.start();
			const start = jest.spyOn( created[ 0 ], 'start' ).mockImplementationOnce( () => {
				throw new Error( 'busy' );
			} );

			created[ 0 ].onend();
			jest.advanceTimersByTime( 249 );
			expect( start ).toHaveBeenCalledTimes( 1 );
			jest.advanceTimersByTime( 1 );

			expect( start ).toHaveBeenCalledTimes( 2 );
			expect( recognizer.restartTimer ).toBeNull();
			expect( events.errors ).toEqual( [] );
		} );
	} );
} );
