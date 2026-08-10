'use strict';

const ServerRecognition = require( '../../resources/serverRecognition.js' );

let recorderInstances;
let analyserLevel;
let apiPosts;

class FakeMediaRecorder {
	constructor( stream, options ) {
		this.stream = stream;
		this.mimeType = ( options && options.mimeType ) || 'audio/webm';
		this.state = 'inactive';
		this.ondataavailable = null;
		this.onstop = null;
		recorderInstances.push( this );
	}

	static isTypeSupported( type ) {
		return type === 'audio/webm;codecs=opus';
	}

	start() {
		this.state = 'recording';
	}

	stop() {
		this.state = 'inactive';
		if ( this.onstop ) {
			this.onstop();
		}
	}
}

class FakeAudioContext {
	createMediaStreamSource() {
		return { connect: () => {} };
	}

	createAnalyser() {
		return {
			fftSize: 512,
			getByteTimeDomainData: ( data ) => {
				data.fill( 128 + Math.round( analyserLevel * 127 ) );
			}
		};
	}

	close() {}
}

class FakeFileReader {
	readAsDataURL() {
		this.result = 'data:audio/webm;base64,QUJDRA==';
		if ( this.onload ) {
			this.onload();
		}
	}
}

function makeStream() {
	const stopped = [];
	return {
		stopped: stopped,
		getTracks: () => [ { stop: () => stopped.push( true ) } ]
	};
}

function makeEngine( configOverrides ) {
	const events = { commands: [], states: [], errors: [] };
	const config = Object.assign( {
		continuousMode: true,
		language: 'en-US'
	}, configOverrides );
	const engine = new ServerRecognition( config, {
		onWake: () => {},
		onCommand: ( text ) => events.commands.push( text ),
		onInterim: () => {},
		onStateChange: ( state ) => events.states.push( state ),
		onError: ( kind ) => events.errors.push( kind )
	} );
	return { engine, events };
}

/**
 * Flush pending microtasks (promise callbacks) while fake timers are active.
 *
 * @return {Promise<void>}
 */
async function flushPromises() {
	for ( let i = 0; i < 5; i++ ) {
		await Promise.resolve();
	}
}

beforeEach( () => {
	jest.useFakeTimers();
	recorderInstances = [];
	analyserLevel = 0;
	apiPosts = [];
	global.window.MediaRecorder = FakeMediaRecorder;
	global.MediaRecorder = FakeMediaRecorder;
	global.window.AudioContext = FakeAudioContext;
	global.FileReader = FakeFileReader;
	global.navigator.mediaDevices = {
		getUserMedia: () => Promise.resolve( makeStream() )
	};
	global.__apiPost = ( params ) => {
		apiPosts.push( params );
		return Promise.resolve( { text: 'navigate to main page' } );
	};
} );

afterEach( () => {
	jest.useRealTimers();
	delete global.window.MediaRecorder;
	delete global.MediaRecorder;
	delete global.window.AudioContext;
	delete global.FileReader;
	delete global.navigator.mediaDevices;
} );

describe( 'ServerRecognition.isSupported', () => {
	it( 'requires getUserMedia and MediaRecorder', () => {
		expect( ServerRecognition.isSupported() ).toBe( true );
		delete global.navigator.mediaDevices;
		expect( ServerRecognition.isSupported() ).toBe( false );
	} );
} );

describe( 'microphone access', () => {
	it( 'reports mic-denied when getUserMedia is rejected', async () => {
		global.navigator.mediaDevices.getUserMedia = () => Promise.reject( new Error( 'denied' ) );
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();
		expect( events.errors ).toContain( 'mic-denied' );
		expect( engine.enabled ).toBe( false );
	} );
} );

describe( 'utterance capture and transcription', () => {
	it( 'records a silence-delimited utterance and sends it to the transcribe API', async () => {
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();
		expect( events.states ).toContain( 'capture' );
		expect( recorderInstances ).toHaveLength( 1 );

		const recorder = recorderInstances[ 0 ];
		expect( recorder.mimeType ).toBe( 'audio/webm;codecs=opus' );
		recorder.ondataavailable( { data: new Blob( [ 'x'.repeat( 5000 ) ] ) } );

		// Speech for a while, then silence long enough to end the segment.
		analyserLevel = 0.5;
		jest.advanceTimersByTime( 300 );
		analyserLevel = 0;
		jest.advanceTimersByTime( 1500 );
		await flushPromises();

		expect( events.states ).toContain( 'processing' );
		expect( apiPosts ).toHaveLength( 1 );
		expect( apiPosts[ 0 ].action ).toBe( 'wandavoicetranscribe' );
		expect( apiPosts[ 0 ].mimetype ).toBe( 'audio/webm' );
		expect( apiPosts[ 0 ].audio ).toBe( 'QUJDRA==' );
		expect( apiPosts[ 0 ].lang ).toBe( 'en-US' );
		expect( events.commands ).toEqual( [ 'navigate to main page' ] );
	} );

	it( 'discards segments without any detected speech', async () => {
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();

		// No speech at all until the maximum segment duration elapses.
		jest.advanceTimersByTime( 31000 );
		await flushPromises();

		expect( apiPosts ).toHaveLength( 0 );
		expect( events.commands ).toEqual( [] );
		// A new segment was started to keep listening.
		expect( recorderInstances.length ).toBeGreaterThanOrEqual( 2 );
	} );

	it( 'reports an error and keeps listening when transcription fails', async () => {
		global.__apiPost = () => Promise.reject( new Error( 'stt down' ) );
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();

		const recorder = recorderInstances[ 0 ];
		recorder.ondataavailable( { data: new Blob( [ 'x'.repeat( 5000 ) ] ) } );
		analyserLevel = 0.5;
		jest.advanceTimersByTime( 300 );
		analyserLevel = 0;
		jest.advanceTimersByTime( 1500 );
		await flushPromises();

		expect( events.errors ).toContain( 'generic' );
		expect( events.commands ).toEqual( [] );
		// Continuous mode resumed a new capture segment after the failure.
		expect( recorderInstances.length ).toBeGreaterThanOrEqual( 2 );
	} );
} );

describe( 'session control', () => {
	it( 'stop releases the microphone and reports the off state', async () => {
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();
		const stream = engine.stream;

		engine.stop();
		expect( engine.enabled ).toBe( false );
		expect( stream.stopped.length ).toBeGreaterThan( 0 );
		expect( events.states ).toContain( 'off' );
	} );

	it( 'resumeWake starts a new segment in continuous mode', async () => {
		const { engine } = makeEngine();
		engine.start();
		await flushPromises();
		const before = recorderInstances.length;

		engine.resumeWake();
		expect( recorderInstances.length ).toBe( before + 1 );
	} );

	it( 'resumeWake stops listening when continuous mode is off', async () => {
		const { engine, events } = makeEngine( { continuousMode: false } );
		engine.start();
		await flushPromises();

		engine.resumeWake();
		expect( engine.enabled ).toBe( false );
		expect( events.states ).toContain( 'off' );
	} );

	it( 'captureNow starts a session when listening is off', async () => {
		const { engine, events } = makeEngine();
		engine.captureNow();
		await flushPromises();

		expect( engine.enabled ).toBe( true );
		expect( events.states ).toContain( 'capture' );
	} );
} );
