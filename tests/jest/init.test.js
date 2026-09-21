'use strict';

// Exercise the real recognizer, processor and executor. Only the browser UI,
// microphone implementation and API transport are replaced.
let panel;
let props;
let recognizers;
let editor;
let save;
let config;
let originalConfigGet;
let originalJQuery;

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise( ( res, rej ) => {
		resolve = res;
		reject = rej;
	} );
	// Deliberately allow completion after abort to test the generation guard.
	promise.abort = jest.fn();
	return { promise, resolve, reject };
}

async function flushPromises() {
	for ( let i = 0; i < 12; i++ ) {
		await Promise.resolve();
	}
}

function hear( text, isFinal = true ) {
	const recognition = recognizers[ recognizers.length - 1 ];
	recognition.onresult( {
		resultIndex: 0,
		results: [ { isFinal, 0: { transcript: text } } ]
	} );
}

function loadInterface() {
	jest.doMock( 'vue', () => ( {
		createMwApp: ( component, options ) => {
			props = options;
			return { mount: () => panel };
		}
	} ), { virtual: true } );
	jest.doMock( '../../resources/components/VoicePanel.vue', () => ( {} ) );
	require( '../../resources/init.js' );
}

beforeEach( () => {
	jest.resetModules();
	global.sessionStorage.clear();
	global.window.location.href = '';
	recognizers = [];
	panel = {};
	for ( const method of [ 'setState', 'setError', 'setThinking', 'setTranscript', 'setFeedback' ] ) {
		panel[ method ] = jest.fn();
	}
	editor = {
		length: 1,
		textSelection: jest.fn( ( method ) => {
			if ( method === 'getCaretPosition' ) {
				return 0;
			}
			return '';
		} )
	};
	save = { length: 1, trigger: jest.fn() };
	originalJQuery = global.$;
	global.$ = ( arg ) => {
		if ( typeof arg === 'function' ) {
			arg();
			return;
		}
		return arg === '#wpTextbox1' ? editor : arg === '#wpSave' ? save : { length: 0 };
	};
	originalConfigGet = global.mw.config.get;
	config = {
		useLLM: true,
		recognitionEngine: 'browser',
		wakePhrase: '',
		continuousMode: true,
		audioFeedback: true
	};
	global.mw.config.get = ( key ) => key === 'wgWandaVoice' ? config : originalConfigGet( key );
	global.window.SpeechRecognition = class {
		constructor() {
			this.start = jest.fn();
			this.abort = jest.fn();
			recognizers.push( this );
		}
	};
	global.window.speechSynthesis = { speak: jest.fn(), cancel: jest.fn() };
	global.SpeechSynthesisUtterance = function ( text ) {
		this.text = text;
	};
	global.document = {
		createElement: () => ( {} ),
		body: { appendChild: jest.fn(), classList: { add: jest.fn() } }
	};
} );

afterEach( () => {
	global.mw.config.get = originalConfigGet;
	global.$ = originalJQuery;
	delete global.window.SpeechRecognition;
	delete global.window.speechSynthesis;
	delete global.SpeechSynthesisUtterance;
	delete global.document;
	jest.dontMock( 'vue' );
	jest.dontMock( '../../resources/components/VoicePanel.vue' );
} );

function clearUiCalls() {
	Object.values( panel ).forEach( ( method ) => method.mockClear() );
	global.window.speechSynthesis.speak.mockClear();
}

function expectNoLateEffects() {
	expect( editor.textSelection ).not.toHaveBeenCalled();
	expect( save.trigger ).not.toHaveBeenCalled();
	expect( global.window.location.href ).toBe( '' );
	Object.values( panel ).forEach( ( method ) => expect( method ).not.toHaveBeenCalled() );
	expect( global.window.speechSynthesis.speak ).not.toHaveBeenCalled();
}

describe( 'listening usability regressions', () => {
	it( 'opens a collapsed panel for a spoken help command', async () => {
		loadInterface();
		props.onToggleListening();
		panel.expanded = false;
		hear( 'help' );
		await flushPromises();
		expect( panel.helpVisible ).toBe( true );
		expect( panel.expanded ).toBe( true );
	} );

	it( 'reports the actionable network message and clears persisted listening on a fatal error', () => {
		loadInterface();
		props.onToggleListening();
		expect( global.sessionStorage.getItem( 'wandavoice-listening' ) ).toBe( '1' );
		clearUiCalls();

		recognizers[ 0 ].onerror( { error: 'network' } );

		expect( panel.setError ).toHaveBeenCalledTimes( 1 );
		expect( panel.setError ).toHaveBeenCalledWith( 'wandavoice-error-network' );
		expect( panel.setState ).toHaveBeenLastCalledWith( 'off' );
		expect( global.sessionStorage.getItem( 'wandavoice-listening' ) ).toBeNull();
		expect( recognizers[ 0 ].abort ).toHaveBeenCalledTimes( 1 );
		expect( global.window.speechSynthesis.speak ).not.toHaveBeenCalled();
	} );

	it( 'clears the listening flag and announces off when the mic explicitly stops listening', () => {
		loadInterface();
		props.onToggleListening();
		expect( global.sessionStorage.getItem( 'wandavoice-listening' ) ).toBe( '1' );
		clearUiCalls();

		props.onToggleListening();

		expect( global.sessionStorage.getItem( 'wandavoice-listening' ) ).toBeNull();
		expect( panel.setState ).toHaveBeenLastCalledWith( 'off' );
		expect( recognizers[ 0 ].abort ).toHaveBeenCalledTimes( 1 );
		expect( global.window.speechSynthesis.speak ).toHaveBeenCalledTimes( 1 );
		expect( global.window.speechSynthesis.speak ).toHaveBeenCalledWith(
			expect.objectContaining( { text: 'wandavoice-feedback-listening-off' } )
		);
	} );

	it.each( [ 'constructor', 'start', 'synchronous network event' ] )( 'does not persist or speak listening-on after a %s failure', ( failure ) => {
		global.window.SpeechRecognition = class {
			constructor() {
				if ( failure === 'constructor' ) {
					throw new Error( 'constructor unavailable' );
				}
				this.abort = jest.fn();
			}

			start() {
				if ( failure === 'start' ) {
					throw new Error( 'cannot start' );
				}
				this.onerror( { error: 'network' } );
			}
		};
		loadInterface();

		expect( () => props.onToggleListening() ).not.toThrow();

		expect( global.sessionStorage.getItem( 'wandavoice-listening' ) ).toBeNull();
		expect( panel.setState.mock.calls ).toEqual( [ [ 'off' ] ] );
		expect( panel.setError ).toHaveBeenCalledWith(
			failure === 'synchronous network event' ? 'wandavoice-error-network' : 'wandavoice-error-generic'
		);
		expect( global.window.speechSynthesis.speak ).not.toHaveBeenCalled();
	} );

	it( 'persists listening and announces on when the user explicitly retries a network failure', () => {
		loadInterface();
		props.onToggleListening();
		recognizers[ 0 ].onerror( { error: 'network' } );
		clearUiCalls();

		props.onToggleListening();

		expect( recognizers ).toHaveLength( 2 );
		expect( recognizers[ 1 ].start ).toHaveBeenCalledTimes( 1 );
		expect( panel.setState ).toHaveBeenLastCalledWith( 'capture' );
		expect( global.sessionStorage.getItem( 'wandavoice-listening' ) ).toBe( '1' );
		expect( global.window.speechSynthesis.speak ).toHaveBeenCalledTimes( 1 );
		expect( global.window.speechSynthesis.speak ).toHaveBeenCalledWith(
			expect.objectContaining( { text: 'wandavoice-feedback-listening-on' } )
		);
	} );
} );

describe( 'configured wake phrase command pipeline', () => {
	let originalApiPost;

	beforeEach( () => {
		config.wakePhrase = 'Wanda';
		originalApiPost = global.__apiPost;
		global.__apiPost = jest.fn( () => Promise.resolve( {} ) );
	} );

	afterEach( () => {
		global.__apiPost = originalApiPost;
	} );

	it.each( [ 'WANDA,', 'WoNdA:' ] )( 'inserts original wikitext exactly once after interim %s type commands', async ( wake ) => {
		const wikitext = 'Wanda, [[NASA|Space]]: Café — https://Example.org/Path?Q=NASA#Top!';
		const command = 'Type ' + wikitext;
		loadInterface();
		props.onToggleListening();
		expect( panel.setState ).toHaveBeenLastCalledWith( 'wake' );
		clearUiCalls();

		for ( const text of [ wake, wake + ' Type', wake + ' ' + command, wake + ' ' + command ] ) {
			hear( text, false );
			await flushPromises();
		}
		expect( editor.textSelection ).not.toHaveBeenCalled();
		expect( panel.setState ).not.toHaveBeenCalled();
		expect( panel.setTranscript ).not.toHaveBeenCalled();
		expect( panel.setFeedback ).not.toHaveBeenCalled();
		expect( global.__apiPost ).not.toHaveBeenCalled();

		hear( wake + ' ' + command );
		await flushPromises();

		expect( editor.textSelection.mock.calls.filter( ( call ) => call[ 0 ] === 'replaceSelection' ) )
			.toEqual( [ [ 'replaceSelection', wikitext ] ] );
		expect( panel.setTranscript.mock.calls ).toEqual( [ [ command ] ] );
		expect( panel.setFeedback.mock.calls.filter( ( call ) => call[ 0 ] === 'wandavoice-feedback-wake' ) )
			.toHaveLength( 1 );
		expect( panel.setState ).toHaveBeenLastCalledWith( 'wake' );
		expect( panel.setError ).not.toHaveBeenCalled();
		expect( global.__apiPost ).not.toHaveBeenCalled();
	} );

	it.each( [ 'Rwanda, Type Wrong!', 'We asked Wanda to Type Wrong!' ] )(
		'does not execute interim wake commands revised to %j', async ( finalText ) => {
			loadInterface();
			props.onToggleListening();
			clearUiCalls();

			hear( 'Wanda, Type Wrong!', false );
			hear( 'Wanda, Type Wrong!', false );
			await flushPromises();
			hear( finalText );
			await flushPromises();

			expectNoLateEffects();
			expect( global.__apiPost ).not.toHaveBeenCalled();
		}
	);

	it.each( [ 'Rwanda', 'Wanda' ] )( 'preserves %s dictation content with a nonempty wake phrase', async ( name ) => {
		config.useLLM = false;
		const content = name + ', NASA!  Café\n你好 https://Example.org/Path?Q=NASA#Top!';
		loadInterface();
		props.onToggleListening();
		hear( 'Wanda: Start Dictation!' );
		await flushPromises();
		expect( panel.setState ).toHaveBeenLastCalledWith( 'dictation' );
		expect( editor.textSelection ).not.toHaveBeenCalled();
		clearUiCalls();

		hear( content, false );
		await flushPromises();
		expect( panel.setTranscript ).toHaveBeenLastCalledWith( content );
		expect( editor.textSelection ).not.toHaveBeenCalled();
		hear( '  ' + content + '\n' );
		await flushPromises();

		expect( editor.textSelection.mock.calls.filter( ( call ) => call[ 0 ] === 'replaceSelection' ) )
			.toEqual( [ [ 'replaceSelection', content ] ] );
		expect( panel.setTranscript ).toHaveBeenLastCalledWith( content );
		expect( panel.setState ).toHaveBeenLastCalledWith( 'dictation' );
		expect( panel.setError ).not.toHaveBeenCalled();
		expect( global.__apiPost ).not.toHaveBeenCalled();
	} );

	it( 'opens help only on a final wake-prefixed control command', async () => {
		loadInterface();
		props.onToggleListening();
		panel.expanded = false;
		panel.helpVisible = false;

		hear( 'Wanda: HELP!', false );
		await flushPromises();
		expect( panel.helpVisible ).toBe( false );
		expect( panel.expanded ).toBe( false );
		hear( 'Wanda: HELP!' );
		await flushPromises();

		expect( panel.helpVisible ).toBe( true );
		expect( panel.expanded ).toBe( true );
		expect( panel.setTranscript ).toHaveBeenLastCalledWith( 'HELP!' );
		expect( panel.setState ).toHaveBeenLastCalledWith( 'wake' );
		expect( panel.setError ).not.toHaveBeenCalled();
		expect( editor.textSelection ).not.toHaveBeenCalled();
		expect( global.__apiPost ).not.toHaveBeenCalled();
	} );
} );

describe( 'command cancellation pipeline', () => {
	it.each( [ false, true ] )( 'ignores a late LLM plan after stop (restart=%s)', async ( restart ) => {
		const request = deferred();
		global.__apiPost = () => request.promise;
		loadInterface();
		props.onToggleListening();
		hear( 'please improve the introduction' );
		props.onToggleListening();
		expect( request.promise.abort ).toHaveBeenCalledTimes( 1 );
		expect( global.sessionStorage.getItem( 'wandavoice-listening' ) ).toBeNull();
		if ( restart ) {
			props.onToggleListening();
		}
		clearUiCalls();
		request.resolve( { actions: [
			{ type: 'start_dictation' },
			{ type: 'insert_text', wikitext: 'Late edit' },
			{ type: 'save' },
			{ type: 'navigate', url: '/wiki/Wrong_page' }
		] } );
		await flushPromises();
		expectNoLateEffects();
		if ( restart ) {
			// The new session must still process normal commands, not dictate them.
			hear( 'save' );
			await flushPromises();
			expect( save.trigger ).toHaveBeenCalledWith( 'click' );
		}
	} );

	it.each( [ false, true ] )( 'suppresses late request errors (restart=%s)', async ( restart ) => {
		const request = deferred();
		global.__apiPost = () => request.promise;
		loadInterface();
		props.onToggleListening();
		hear( 'please improve the introduction' );
		props.onToggleListening();
		if ( restart ) {
			props.onToggleListening();
		}
		clearUiCalls();
		request.reject( new Error( 'aborted or disconnected' ) );
		await flushPromises();
		expectNoLateEffects();
	} );

	it( 'cancels an already-parsed local command before its async continuation', async () => {
		loadInterface();
		props.onToggleListening();
		hear( 'save' );
		props.onToggleListening();
		clearUiCalls();
		await flushPromises();
		expectNoLateEffects();
	} );

	it( 'does not restart dictation when its pending cleanup completes after stop', async () => {
		const request = deferred();
		global.__apiPost = () => request.promise;
		loadInterface();
		props.onToggleListening();
		hear( 'start dictation' );
		await flushPromises();
		hear( 'Hello world' );
		props.onToggleListening();
		clearUiCalls();
		request.resolve( { actions: [ { type: 'insert_text', wikitext: 'Hello world.' } ] } );
		await flushPromises();
		expectNoLateEffects();
	} );

	it.each( [ 'cancel', 'stop_listening' ] )( 'halts the whole plan on %s', async ( type ) => {
		global.__apiPost = () => Promise.resolve( {
			actions: [ { type, feedback: 'Stopped' }, { type: 'insert_text', wikitext: 'No' }, { type: 'save' } ]
		} );
		loadInterface();
		props.onToggleListening();
		global.sessionStorage.setItem( 'wandavoice-pending-actions', '[{"type":"save"}]' );
		hear( 'please cancel everything' );
		await flushPromises();
		expect( editor.textSelection ).not.toHaveBeenCalled();
		expect( save.trigger ).not.toHaveBeenCalled();
		expect( recognizers[ 0 ].abort ).toHaveBeenCalledTimes( 1 );
		expect( panel.setState ).toHaveBeenLastCalledWith( 'off' );
		expect( global.sessionStorage.getItem( 'wandavoice-pending-actions' ) ).toBeNull();
		expect( global.sessionStorage.getItem( 'wandavoice-listening' ) ).toBeNull();
	} );

	it( 'invalidates pending commands when the recognition engine stops on an error', async () => {
		const request = deferred();
		global.__apiPost = () => request.promise;
		loadInterface();
		props.onToggleListening();
		hear( 'please improve the introduction' );
		recognizers[ 0 ].onerror( { error: 'not-allowed' } );
		clearUiCalls();
		request.resolve( { actions: [ { type: 'save' } ] } );
		await flushPromises();
		expectNoLateEffects();
	} );

	it( 'executes a current LLM response and resumes listening', async () => {
		global.__apiPost = () => Promise.resolve( { actions: [
			{ type: 'insert_text', wikitext: 'Current edit' }, { type: 'save' }
		] } );
		loadInterface();
		props.onToggleListening();
		hear( 'please improve the introduction' );
		await flushPromises();
		expect( editor.textSelection ).toHaveBeenCalledWith( 'replaceSelection', 'Current edit' );
		expect( save.trigger ).toHaveBeenCalledWith( 'click' );
		expect( panel.setState ).toHaveBeenLastCalledWith( 'capture' );
	} );

	it( 'reports genuine API errors in the current session', async () => {
		global.__apiPost = () => Promise.reject( new Error( 'service unavailable' ) );
		loadInterface();
		props.onToggleListening();
		hear( 'please improve the introduction' );
		await flushPromises();
		expect( panel.setError ).toHaveBeenCalledWith( 'wandavoice-error-generic' );
		expect( panel.setState ).toHaveBeenLastCalledWith( 'capture' );
	} );
} );
