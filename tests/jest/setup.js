'use strict';

/**
 * Minimal MediaWiki and browser environment for WandaVoice unit tests.
 *
 * Tests can override `global.__apiPost` to control mw.Api responses and
 * `global.$` to fake the editor textarea.
 */

global.window = { location: { href: '' } };
global.navigator = {};

const storage = new Map();
global.sessionStorage = {
	getItem: ( key ) => storage.has( key ) ? storage.get( key ) : null,
	setItem: ( key, value ) => storage.set( key, String( value ) ),
	removeItem: ( key ) => storage.delete( key ),
	clear: () => storage.clear()
};

global.__apiPost = () => Promise.resolve( {} );

global.mw = {
	message: ( key, ...params ) => ( {
		text: () => params.length ? key + ':' + params.join( '|' ) : key
	} ),
	util: {
		getUrl: ( title, params ) => '/wiki/' + title +
			( params ? '?' + new URLSearchParams( params ).toString() : '' )
	},
	config: {
		get: ( key ) => key === 'wgPageName' ? 'Test_Page' : null
	},
	Api: function () {
		return { post: ( params ) => global.__apiPost( params ) };
	}
};

global.$ = () => ( { length: 0 } );
