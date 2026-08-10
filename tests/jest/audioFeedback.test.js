'use strict';

const AudioFeedback = require( '../../resources/audioFeedback.js' );

let spoken;
let cancelled;
let oscillators;

class FakeOscillator {
	constructor() {
		this.type = 'sine';
		this.started = false;
		this.frequency = {
			setValueAtTime: () => {},
			linearRampToValueAtTime: () => {}
		};
		oscillators.push( this );
	}

	connect() {}

	start() {
		this.started = true;
	}

	stop() {}
}

class FakeAudioContext {
	constructor() {
		this.currentTime = 0;
		this.destination = {};
		FakeAudioContext.instances++;
	}

	createOscillator() {
		return new FakeOscillator();
	}

	createGain() {
		return {
			connect: () => {},
			gain: {
				setValueAtTime: () => {},
				exponentialRampToValueAtTime: () => {}
			}
		};
	}
}
FakeAudioContext.instances = 0;

function makeAudio( configOverrides ) {
	return new AudioFeedback( Object.assign( {
		audioFeedback: true,
		hapticFeedback: true,
		language: 'en-US'
	}, configOverrides ) );
}

beforeEach( () => {
	spoken = [];
	cancelled = 0;
	oscillators = [];
	FakeAudioContext.instances = 0;
	global.window.speechSynthesis = {
		cancel: () => cancelled++,
		speak: ( utterance ) => spoken.push( utterance )
	};
	global.SpeechSynthesisUtterance = function ( text ) {
		this.text = text;
	};
	global.window.AudioContext = FakeAudioContext;
	global.navigator.vibrate = null;
} );

afterEach( () => {
	delete global.window.speechSynthesis;
	delete global.window.AudioContext;
	delete global.SpeechSynthesisUtterance;
	delete global.navigator.vibrate;
} );

describe( 'speak', () => {
	it( 'cancels previous speech and speaks with the configured language', () => {
		makeAudio().speak( 'Navigating to Main Page.' );
		expect( cancelled ).toBe( 1 );
		expect( spoken ).toHaveLength( 1 );
		expect( spoken[ 0 ].text ).toBe( 'Navigating to Main Page.' );
		expect( spoken[ 0 ].lang ).toBe( 'en-US' );
	} );

	it( 'does nothing when audio feedback is disabled', () => {
		makeAudio( { audioFeedback: false } ).speak( 'hello' );
		expect( spoken ).toHaveLength( 0 );
		expect( cancelled ).toBe( 0 );
	} );

	it( 'does nothing for empty text', () => {
		makeAudio().speak( '' );
		expect( spoken ).toHaveLength( 0 );
	} );

	it( 'stopSpeaking cancels without speaking', () => {
		makeAudio().stopSpeaking();
		expect( cancelled ).toBe( 1 );
		expect( spoken ).toHaveLength( 0 );
	} );
} );

describe( 'earcon', () => {
	it( 'plays a tone and reuses one AudioContext across calls', () => {
		const audio = makeAudio();
		audio.earcon( 'wake' );
		audio.earcon( 'stop' );
		expect( oscillators ).toHaveLength( 2 );
		expect( oscillators[ 0 ].started ).toBe( true );
		expect( FakeAudioContext.instances ).toBe( 1 );
	} );

	it( 'uses a square wave for the error tone', () => {
		makeAudio().earcon( 'error' );
		expect( oscillators[ 0 ].type ).toBe( 'square' );
	} );

	it( 'does nothing when audio feedback is disabled', () => {
		makeAudio( { audioFeedback: false } ).earcon( 'wake' );
		expect( oscillators ).toHaveLength( 0 );
	} );
} );

describe( 'vibrate', () => {
	it( 'vibrates briefly when haptics are enabled and supported', () => {
		const vibrations = [];
		global.navigator.vibrate = ( ms ) => vibrations.push( ms );
		makeAudio().vibrate();
		expect( vibrations ).toEqual( [ 40 ] );
	} );

	it( 'does nothing when haptics are disabled', () => {
		const vibrations = [];
		global.navigator.vibrate = ( ms ) => vibrations.push( ms );
		makeAudio( { hapticFeedback: false } ).vibrate();
		expect( vibrations ).toEqual( [] );
	} );

	it( 'tolerates browsers without vibration support', () => {
		expect( () => makeAudio().vibrate() ).not.toThrow();
	} );
} );
