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

function deferred( abortable = false ) {
	let resolve, reject;
	const promise = new Promise( ( resolvePromise, rejectPromise ) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	} );
	if ( abortable ) {
		// Aborting need not prevent a response that was already queued.
		promise.abort = jest.fn();
	}
	return { promise, resolve, reject };
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

describe( 'session cancellation regressions', () => {
	let readers;
	let originalPost;

	class DeferredFileReader {
		constructor() {
			this.readyState = 0;
			this.result = 'data:audio/webm;base64,QUJDRA==';
			this.abort = jest.fn( () => {
				this.readyState = 2;
			} );
			readers.push( this );
		}

		readAsDataURL() {
			this.readyState = 1;
		}
	}

	function finishRead( reader ) {
		reader.readyState = 2;
		reader.onload();
	}

	beforeEach( () => {
		readers = [];
		originalPost = global.__apiPost;
	} );

	afterEach( () => {
		global.__apiPost = originalPost;
		jest.restoreAllMocks();
	} );

	describe.each( [ false, true ] )( 'restart = %s', ( restart ) => {
		it.each( [ 'success', 'failure' ] )( 'ignores deferred microphone %s after stopping', async ( outcome ) => {
			const microphone = deferred();
			const oldStream = makeStream();
			const newStream = makeStream();
			global.navigator.mediaDevices.getUserMedia = jest.fn()
				.mockReturnValueOnce( microphone.promise )
				.mockResolvedValueOnce( newStream );
			const { engine, events } = makeEngine();
			engine.start();
			engine.stop();
			if ( restart ) {
				engine.start();
				await flushPromises();
			}
			const states = events.states.slice();
			const recorder = engine.recorder;
			const monitor = engine.monitorTimer;

			if ( outcome === 'success' ) {
				microphone.resolve( oldStream );
			} else {
				microphone.reject( new Error( 'old permission denied' ) );
			}
			await flushPromises();

			expect( oldStream.stopped ).toEqual( outcome === 'success' ? [ true ] : [] );
			expect( newStream.stopped ).toEqual( [] );
			expect( engine.stream ).toBe( restart ? newStream : null );
			expect( engine.enabled ).toBe( restart );
			expect( engine.recorder ).toBe( recorder );
			expect( engine.monitorTimer ).toBe( monitor );
			expect( recorderInstances ).toHaveLength( restart ? 1 : 0 );
			expect( events ).toEqual( { commands: [], states, errors: [] } );
			expect( apiPosts ).toEqual( [] );
		} );

		it.each( [ 'onload', 'onerror' ] )( 'ignores queued FileReader %s without upload or UI changes', async ( callback ) => {
			global.FileReader = DeferredFileReader;
			const { engine, events } = makeEngine();
			engine.start();
			await flushPromises();
			engine.transcribe( new Blob( [ 'old audio' ] ) );
			const oldReader = readers[ 0 ];
			const queuedCallback = oldReader[ callback ];
			expect( engine.reader ).toBe( oldReader );
			expect( oldReader.readyState ).toBe( 1 );

			engine.stop();
			expect( oldReader.abort ).toHaveBeenCalledTimes( 1 );
			expect( oldReader.onload ).toBeNull();
			expect( oldReader.onerror ).toBeNull();
			expect( engine.reader ).toBeNull();
			if ( restart ) {
				engine.start();
				await flushPromises();
				engine.transcribe( new Blob( [ 'new audio' ] ) );
			}
			const currentReader = engine.reader;
			const states = events.states.slice();
			const resume = jest.spyOn( engine, 'resumeWake' );

			queuedCallback();
			await flushPromises();

			expect( apiPosts ).toEqual( [] );
			expect( events ).toEqual( { commands: [], states, errors: [] } );
			expect( resume ).not.toHaveBeenCalled();
			expect( engine.reader ).toBe( currentReader );
			expect( engine.enabled ).toBe( restart );
			if ( restart ) {
				finishRead( currentReader );
				await flushPromises();
				expect( events.commands ).toEqual( [ 'navigate to main page' ] );
				expect( apiPosts ).toHaveLength( 1 );
				expect( engine.reader ).toBeNull();
				expect( engine.request ).toBeNull();
			}
		} );

		describe.each( [ false, true ] )( 'abortable STT = %s', ( abortable ) => {
			it.each( [ 'success', 'error', 'empty' ] )( 'ignores late STT %s and preserves current work', async ( outcome ) => {
				const old = deferred( abortable );
				const current = deferred( true );
				global.__apiPost = jest.fn().mockReturnValueOnce( old.promise )
					.mockReturnValueOnce( current.promise );
				const { engine, events } = makeEngine();
				engine.start();
				await flushPromises();
				engine.transcribe( new Blob( [ 'old audio' ] ) );
				expect( engine.request ).toBe( old.promise );
				const stream = engine.stream;

				engine.stop();
				expect( stream.stopped ).toEqual( [ true ] );
				expect( engine.request ).toBeNull();
				if ( abortable ) {
					expect( old.promise.abort ).toHaveBeenCalledTimes( 1 );
				}
				if ( restart ) {
					engine.start();
					await flushPromises();
					engine.transcribe( new Blob( [ 'new audio' ] ) );
				}
				const states = events.states.slice();
				const recorder = engine.recorder;
				const monitor = engine.monitorTimer;
				const resume = jest.spyOn( engine, 'resumeWake' );

				if ( outcome === 'error' ) {
					old.reject( new Error( 'old STT failed' ) );
				} else {
					old.resolve( { text: outcome === 'empty' ? '  ' : 'save' } );
				}
				await flushPromises();

				expect( events ).toEqual( { commands: [], states, errors: [] } );
				expect( resume ).not.toHaveBeenCalled();
				expect( engine.enabled ).toBe( restart );
				expect( engine.recorder ).toBe( recorder );
				expect( engine.monitorTimer ).toBe( monitor );
				expect( engine.request ).toBe( restart ? current.promise : null );
				expect( global.__apiPost ).toHaveBeenCalledTimes( restart ? 2 : 1 );
				if ( restart ) {
					current.resolve( { text: '  search for cats  ' } );
					await flushPromises();
					expect( events.commands ).toEqual( [ 'search for cats' ] );
					expect( engine.request ).toBeNull();
					engine.stop();
					expect( current.promise.abort ).not.toHaveBeenCalled();
				}
			} );
		} );
	} );

	it.each( [ 'stop/start', 'new segment' ] )( 'queued recorder callbacks cannot disrupt the monitor after %s', async ( transition ) => {
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();
		const old = engine.recorder;
		const data = old.ondataavailable;
		const stopped = old.onstop;
		// Capture the interval callback as if it had already entered the task queue.
		const interval = jest.spyOn( global, 'setInterval' );
		engine.beginSegment();
		const queuedRecorder = engine.recorder;
		const queuedData = queuedRecorder.ondataavailable;
		const queuedStop = queuedRecorder.onstop;
		const tick = interval.mock.calls[ 0 ][ 0 ];
		analyserLevel = 0.5;
		jest.advanceTimersByTime( 100 );
		if ( transition === 'stop/start' ) {
			engine.stop();
			expect( queuedRecorder.ondataavailable ).toBeNull();
			expect( queuedRecorder.onstop ).toBeNull();
			engine.start();
			await flushPromises();
		} else {
			engine.beginSegment();
		}
		const current = engine.recorder;
		const monitor = engine.monitorTimer;
		const states = events.states.slice();
		const count = recorderInstances.length;
		const stopMonitor = jest.spyOn( engine, 'stopMonitor' );
		const level = jest.spyOn( engine, 'inputLevel' );
		const readData = jest.fn( () => new Blob( [ 'x'.repeat( 5000 ) ] ) );
		const queuedEvent = Object.defineProperty( {}, 'data', { get: readData } );

		data( queuedEvent );
		stopped();
		queuedData( queuedEvent );
		queuedStop();
		queuedRecorder.state = 'inactive';
		tick();

		expect( stopMonitor ).not.toHaveBeenCalled();
		expect( level ).not.toHaveBeenCalled();
		expect( readData ).not.toHaveBeenCalled();
		expect( engine.recorder ).toBe( current );
		expect( engine.monitorTimer ).toBe( monitor );
		expect( jest.getTimerCount() ).toBe( 1 );
		expect( recorderInstances ).toHaveLength( count );
		expect( events ).toEqual( { commands: [], states, errors: [] } );
		expect( apiPosts ).toEqual( [] );

		// The surviving monitor must still transcribe a real current utterance.
		current.ondataavailable( { data: new Blob( [ 'x'.repeat( 5000 ) ] ) } );
		jest.advanceTimersByTime( 100 );
		analyserLevel = 0;
		jest.advanceTimersByTime( 1500 );
		await flushPromises();
		expect( events.commands ).toEqual( [ 'navigate to main page' ] );
	} );

	it.each( [ 'success', 'error', 'empty' ] )( 'releases a completed active STT request on %s', async ( outcome ) => {
		const request = deferred( true );
		global.__apiPost = () => request.promise;
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();
		engine.transcribe( new Blob( [ 'audio' ] ) );
		const resume = jest.spyOn( engine, 'resumeWake' );

		if ( outcome === 'error' ) {
			request.reject( new Error( 'STT unavailable' ) );
		} else {
			request.resolve( { text: outcome === 'empty' ? ' ' : ' save ' } );
		}
		await flushPromises();

		expect( engine.request ).toBeNull();
		expect( events.commands ).toEqual( outcome === 'success' ? [ 'save' ] : [] );
		expect( events.errors ).toEqual( outcome === 'error' ? [ 'generic' ] : [] );
		expect( resume ).toHaveBeenCalledTimes( outcome === 'success' ? 0 : 1 );
		engine.stop();
		expect( request.promise.abort ).not.toHaveBeenCalled();
	} );

	it( 'releases a failed active reader and resumes capture', async () => {
		global.FileReader = DeferredFileReader;
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();
		engine.transcribe( new Blob( [ 'audio' ] ) );
		const resume = jest.spyOn( engine, 'resumeWake' );

		readers[ 0 ].onerror();

		expect( engine.reader ).toBeNull();
		expect( events.errors ).toEqual( [ 'generic' ] );
		expect( resume ).toHaveBeenCalledTimes( 1 );
		expect( apiPosts ).toEqual( [] );
		engine.stop();
		expect( readers[ 0 ].abort ).not.toHaveBeenCalled();
	} );

	it.each( [ 'rejects', 'throws' ] )( 'still releases resources when transport abort %s', async ( behavior ) => {
		const request = deferred( true );
		request.promise.abort.mockImplementation( () => {
			if ( behavior === 'throws' ) {
				throw new Error( 'abort failed' );
			}
			request.reject( new Error( 'aborted' ) );
		} );
		global.__apiPost = () => request.promise;
		const { engine, events } = makeEngine();
		engine.start();
		await flushPromises();
		const stream = engine.stream;
		const close = jest.spyOn( engine.audioContext, 'close' );
		engine.transcribe( new Blob( [ 'audio' ] ) );

		engine.stop();
		if ( behavior === 'throws' ) {
			request.resolve( { text: 'save' } );
		}
		await flushPromises();

		expect( request.promise.abort ).toHaveBeenCalledTimes( 1 );
		expect( stream.stopped ).toEqual( [ true ] );
		expect( close ).toHaveBeenCalledTimes( 1 );
		expect( engine.stream ).toBeNull();
		expect( engine.audioContext ).toBeNull();
		expect( engine.recorder ).toBeNull();
		expect( engine.request ).toBeNull();
		expect( jest.getTimerCount() ).toBe( 0 );
		expect( events.commands ).toEqual( [] );
		expect( events.errors ).toEqual( [] );
	} );
} );
