'use strict';

const fs = require( 'fs' );
const path = require( 'path' );
const vm = require( 'vm' );
const codex = require( './__mocks__/codex.js' );

const source = fs.readFileSync(
	path.join( __dirname, '../../resources/components/VoicePanel.vue' ), 'utf8'
);
const template = source.match( /<template>([\s\S]*?)<\/template>/ )[ 1 ];
const script = source.match( /<script>([\s\S]*?)<\/script>/ )[ 1 ];

// Exercise the actual Options API script without a Vue compiler or DOM dependency.
// This harness does not claim to test Vue rendering, event dispatch or browser focus.
function makePanel( overrides = {} ) {
	const module = { exports: {} };
	vm.runInNewContext( script, {
		module,
		exports: module.exports,
		require: ( name ) => {
			if ( name !== '../../codex.js' ) {
				throw new Error( 'Unexpected component dependency: ' + name );
			}
			return codex;
		},
		mw: global.mw
	} );
	const component = module.exports;
	const ticks = [];
	const panel = Object.assign( {
		visualIndicators: true,
		unsupported: false,
		wakePhrase: 'wanda',
		onToggleListening: null,
		onPushToTalk: null,
		$emit: jest.fn(),
		$refs: { micButton: { focus: jest.fn() } },
		$nextTick: ( callback ) => ticks.push( callback )
	}, component.data(), overrides );
	Object.entries( component.methods ).forEach( ( [ name, method ] ) => {
		panel[ name ] = method.bind( panel );
	} );
	Object.entries( component.computed ).forEach( ( [ name, getter ] ) => {
		Object.defineProperty( panel, name, { get: getter.bind( panel ) } );
	} );
	return {
		panel,
		flushTicks: () => {
			while ( ticks.length ) {
				ticks.shift()();
			}
		}
	};
}

describe( 'VoicePanel usability regressions (Options API, not rendered DOM)', () => {
	describe.each( [ 'off', 'wake', 'capture', 'processing', 'dictation' ] )( 'state=%s', ( state ) => {
		it( 'routes the mic to the toggle callback, never push-to-talk or an emit', () => {
			const onToggleListening = jest.fn();
			const onPushToTalk = jest.fn();
			const { panel } = makePanel( { state, onToggleListening, onPushToTalk } );

			panel.onMicClick();

			expect( onToggleListening ).toHaveBeenCalledTimes( 1 );
			expect( onPushToTalk ).not.toHaveBeenCalled();
			expect( panel.$emit ).not.toHaveBeenCalled();
		} );

		it( 'emits only toggle-listening when no toggle callback is supplied', () => {
			const onPushToTalk = jest.fn();
			const { panel } = makePanel( { state, onPushToTalk } );

			panel.onMicClick();

			expect( panel.$emit ).toHaveBeenCalledTimes( 1 );
			expect( panel.$emit ).toHaveBeenCalledWith( 'toggle-listening' );
			expect( onPushToTalk ).not.toHaveBeenCalled();
		} );

		it( 'bases card visibility on expansion rather than listening state', () => {
			const { panel } = makePanel( { state } );

			expect( panel.isCardVisible ).toBe( false );
			panel.expanded = true;
			expect( panel.isCardVisible ).toBe( true );
			panel.visualIndicators = false;
			expect( panel.isCardVisible ).toBe( false );
		} );
	} );

	it( 'routes the separate capture action to its callback without toggling or emitting', () => {
		const onToggleListening = jest.fn();
		const onPushToTalk = jest.fn();
		const { panel } = makePanel( { state: 'wake', onToggleListening, onPushToTalk } );

		panel.pushToTalk();

		expect( onPushToTalk ).toHaveBeenCalledTimes( 1 );
		expect( onToggleListening ).not.toHaveBeenCalled();
		expect( panel.$emit ).not.toHaveBeenCalled();
	} );

	it( 'emits only push-to-talk when the separate capture callback is absent', () => {
		const onToggleListening = jest.fn();
		const { panel } = makePanel( { state: 'wake', onToggleListening } );

		panel.pushToTalk();

		expect( panel.$emit ).toHaveBeenCalledTimes( 1 );
		expect( panel.$emit ).toHaveBeenCalledWith( 'push-to-talk' );
		expect( onToggleListening ).not.toHaveBeenCalled();
	} );

	it( 'keeps a dismissed card closed through active transitions without stopping listening', () => {
		const onToggleListening = jest.fn();
		const { panel, flushTicks } = makePanel( { state: 'wake', expanded: true, onToggleListening } );

		panel.closePanel();
		expect( panel.isCardVisible ).toBe( false );
		for ( const state of [ 'capture', 'processing', 'capture', 'dictation', 'wake' ] ) {
			panel.setState( state );
			flushTicks();
			expect( panel.isCardVisible ).toBe( false );
			expect( panel.state ).toBe( state );
		}

		expect( onToggleListening ).not.toHaveBeenCalled();
		expect( panel.$emit ).not.toHaveBeenCalled();
	} );

	it( 'returns focus to the microphone on the next tick after closing', () => {
		const { panel, flushTicks } = makePanel( { expanded: true } );

		panel.closePanel();

		expect( panel.expanded ).toBe( false );
		expect( panel.$refs.micButton.focus ).not.toHaveBeenCalled();
		flushTicks();
		expect( panel.$refs.micButton.focus ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'closes safely when the microphone ref is unavailable', () => {
		const { panel, flushTicks } = makePanel( { visualIndicators: false, $refs: {} } );

		panel.closePanel();

		expect( flushTicks ).not.toThrow();
		expect( panel.isCardVisible ).toBe( false );
	} );

	it.each( [ 'wake', 'capture', 'processing', 'dictation' ] )( 'expands on off -> %s', ( state ) => {
		const { panel } = makePanel();

		panel.setState( state );

		expect( panel.state ).toBe( state );
		expect( panel.isCardVisible ).toBe( true );
	} );

	it( 'does not expand an already-off card on another off notification', () => {
		const { panel } = makePanel();

		panel.setState( 'off' );

		expect( panel.isCardVisible ).toBe( false );
	} );

	it.each( [ 'error', 'feedback' ] )( 'preserves transcript and %s when processing returns to capture', ( kind ) => {
		const { panel } = makePanel( { state: 'processing', expanded: true } );
		panel.setTranscript( 'save this page' );
		if ( kind === 'error' ) {
			panel.setError( 'Please retry' );
		} else {
			panel.setFeedback( 'Saved' );
		}
		const message = panel[ kind ];

		panel.setState( 'capture' );

		expect( panel.transcript ).toBe( 'save this page' );
		expect( panel[ kind ] ).toBe( message );
	} );

	it( 'clears old messages and expands before invoking an explicit start', () => {
		let atStart;
		const { panel } = makePanel( {
			transcript: 'old command', error: 'old error', feedback: 'old feedback',
			onToggleListening: () => {
				atStart = {
					transcript: panel.transcript, error: panel.error,
					feedback: panel.feedback, expanded: panel.expanded
				};
			}
		} );

		panel.onMicClick();

		expect( atStart ).toEqual( { transcript: '', error: '', feedback: '', expanded: true } );
	} );

	it( 'preserves messages when the mic is used to stop active listening', () => {
		const { panel } = makePanel( {
			state: 'capture', transcript: 'last command', error: 'last error', feedback: 'last feedback'
		} );

		panel.onMicClick();

		expect( panel.transcript ).toBe( 'last command' );
		expect( panel.error ).toBe( 'last error' );
		expect( panel.feedback ).toBe( 'last feedback' );
	} );

	it( 'reopens a dismissed card for an error and announces it', () => {
		const { panel, flushTicks } = makePanel( { state: 'capture', feedback: 'old feedback' } );
		panel.closePanel();

		panel.setError( 'Network unavailable; try again' );
		flushTicks();

		expect( panel.isCardVisible ).toBe( true );
		expect( panel.error ).toBe( 'Network unavailable; try again' );
		expect( panel.feedback ).toBe( '' );
		expect( panel.liveAnnouncement ).toBe( panel.error );
	} );
} );

describe( 'VoicePanel template compatibility (static checks)', () => {
	it( 'shows only the microphone in the floating toolbar', () => {
		const toolbar = template.match( /<div class="wandavoice-toolbar">([\s\S]*?)<\/div>/ )[ 1 ];
		expect( toolbar ).toContain( 'class="wandavoice-mic-button"' );
		expect( toolbar.match( /<button\s/g ) ).toHaveLength( 1 );
		expect( template ).not.toContain( 'wandavoice-details-button' );
	} );

	it( 'uses only kebab-case Codex tags for the MediaWiki HTML template parser', () => {
		const tags = template.match( /<\/?cdx[^\s>/]*/gi );

		expect( tags ).not.toBeNull();
		expect( tags ).toEqual( expect.arrayContaining( [
			'<cdx-button', '</cdx-button', '<cdx-message', '</cdx-message',
			'<cdx-progress-bar', '</cdx-progress-bar'
		] ) );
		tags.forEach( ( tag ) => expect( tag ).toMatch( /^<\/?cdx-(?:button|message|progress-bar)$/ ) );
	} );

	it( 'wires mic, close and wake capture to their separate actions', () => {
		expect( template ).toMatch( /<button\s[^>]*class="wandavoice-mic-button"[^>]*@click="onMicClick"/ );
		expect( template ).toMatch( /<cdx-button\s[^>]*@click="closePanel"/ );
		expect( template ).toMatch( /<cdx-button\s[^>]*v-if="state === 'wake'"[^>]*@click="pushToTalk"/ );
		expect( template ).toMatch( /<button\s[^>]*ref="micButton"/ );
		expect( template ).toMatch( /<div\s+v-if="isCardVisible"\s+id="wandavoice-status-card"/ );
	} );
} );
