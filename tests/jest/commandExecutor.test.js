'use strict';

const CommandExecutor = require( '../../resources/commandExecutor.js' );

const STORAGE_KEY = 'wandavoice-pending-actions';

function makeExecutor() {
	const feedback = [];
	const errors = [];
	const executor = new CommandExecutor( {}, {
		onFeedback: ( text ) => feedback.push( text ),
		onError: ( text ) => errors.push( text )
	} );
	return { executor, feedback, errors };
}

/**
 * Fake jQuery textarea implementing the textSelection API.
 *
 * @param {string} contents Initial editor contents
 * @return {Object}
 */
function makeTextarea( contents ) {
	const calls = [];
	const textarea = {
		length: 1,
		value: contents,
		selection: '',
		caret: contents.length,
		textSelection: function ( method, arg ) {
			calls.push( [ method, arg ] );
			switch ( method ) {
				case 'getContents':
					return textarea.value;
				case 'setContents':
					textarea.value = arg;
					return textarea;
				case 'getSelection':
					return textarea.selection;
				case 'getCaretPosition':
					return textarea.caret;
				case 'replaceSelection':
					textarea.value = textarea.value.slice( 0, textarea.caret ) + arg +
						textarea.value.slice( textarea.caret );
					return textarea;
				case 'encapsulateSelection':
					return textarea;
				case 'scrollToCaretPosition':
					return textarea;
			}
		},
		calls: calls
	};
	return textarea;
}

beforeEach( () => {
	global.sessionStorage.clear();
	global.window.location.href = '';
	global.$ = () => ( { length: 0 } );
} );

describe( 'navigation actions', () => {
	it( 'navigates and stashes the remaining actions for the next page', async () => {
		const { executor, feedback } = makeExecutor();
		await executor.executeActions( [
			{ type: 'navigate', url: '/wiki/Albert_Einstein', status: 'ready', feedback: 'going' },
			{ type: 'insert_text', wikitext: 'He was born in Germany.', status: 'ready' }
		] );

		expect( global.window.location.href ).toBe( '/wiki/Albert_Einstein' );
		expect( feedback ).toContain( 'going' );
		const pending = JSON.parse( global.sessionStorage.getItem( STORAGE_KEY ) );
		expect( pending ).toHaveLength( 1 );
		expect( pending[ 0 ].type ).toBe( 'insert_text' );
	} );

	it( 'skips actions the server marked as failed', async () => {
		const { executor, feedback } = makeExecutor();
		await executor.executeActions( [
			{ type: 'navigate', target: 'Nowhere', status: 'not_found', feedback: 'not found' }
		] );
		expect( global.window.location.href ).toBe( '' );
		expect( feedback ).toContain( 'not found' );
	} );
} );

describe( 'takePendingActions', () => {
	it( 'returns and clears stashed actions', () => {
		const { executor } = makeExecutor();
		global.sessionStorage.setItem( STORAGE_KEY, JSON.stringify( [ { type: 'undo' } ] ) );

		const pending = executor.takePendingActions();
		expect( pending ).toEqual( [ { type: 'undo' } ] );
		expect( global.sessionStorage.getItem( STORAGE_KEY ) ).toBeNull();
		expect( executor.takePendingActions() ).toEqual( [] );
	} );

	it( 'tolerates corrupted stash data', () => {
		const { executor } = makeExecutor();
		global.sessionStorage.setItem( STORAGE_KEY, 'not json{' );
		expect( executor.takePendingActions() ).toEqual( [] );
	} );
} );

describe( 'editor actions', () => {
	it( 'reports an error when no editor is open', async () => {
		const { executor, errors } = makeExecutor();
		await executor.executeActions( [
			{ type: 'insert_text', wikitext: 'hello', status: 'ready' }
		] );
		expect( errors ).toContain( 'wandavoice-error-noeditor' );
	} );

	it( 'inserts text with a separating space after flowing text', async () => {
		const textarea = makeTextarea( 'Hello' );
		global.$ = () => textarea;
		const { executor, feedback } = makeExecutor();

		await executor.executeActions( [
			{ type: 'insert_text', wikitext: 'world', status: 'ready', feedback: 'inserted' }
		] );

		expect( textarea.value ).toBe( 'Hello world' );
		expect( feedback ).toContain( 'inserted' );
		// A snapshot must have been taken for undo.
		expect( executor.undoStack ).toEqual( [ 'Hello' ] );
	} );

	it( 'wraps the selection for formatting actions', async () => {
		const textarea = makeTextarea( 'some text' );
		global.$ = () => textarea;
		const { executor } = makeExecutor();

		await executor.executeActions( [
			{ type: 'format', wrap: { pre: "'''", post: "'''" }, status: 'ready' }
		] );

		expect( textarea.calls ).toContainEqual(
			[ 'encapsulateSelection', { pre: "'''", post: "'''" } ]
		);
	} );

	it( 'clears selection when requested', async () => {
		const textarea = makeTextarea( 'some text' );
		global.$ = () => textarea;
		const { executor } = makeExecutor();

		await executor.executeActions( [
			{ type: 'format', style: 'clear', clear: true, status: 'ready' }
		] );

		expect( textarea.calls ).toContainEqual(
			[ 'replaceSelection', '' ]
		);
	} );

	it( 'undoes the last voice edit and reports when nothing is left', async () => {
		const textarea = makeTextarea( 'changed' );
		global.$ = () => textarea;
		const { executor, feedback } = makeExecutor();

		executor.undoStack.push( 'original' );
		await executor.executeActions( [ { type: 'undo', status: 'ready', feedback: 'undone' } ] );
		expect( textarea.value ).toBe( 'original' );
		expect( feedback ).toContain( 'undone' );

		await executor.executeActions( [ { type: 'undo', status: 'ready', feedback: 'undone' } ] );
		expect( feedback ).toContain( 'wandavoice-feedback-nothing-to-undo' );
	} );

	it( 'inserts markup actions without extra spacing', async () => {
		const textarea = makeTextarea( 'Hello' );
		global.$ = () => textarea;
		const { executor } = makeExecutor();

		await executor.executeActions( [
			{ type: 'link', wikitext: '[[Paris]]', status: 'ready' }
		] );
		expect( textarea.value ).toBe( 'Hello[[Paris]]' );
	} );

	it( 'inserts table, reference, category, and numbered list actions', async () => {
		const textarea = makeTextarea( '' );
		global.$ = () => textarea;
		const { executor } = makeExecutor();

		await executor.executeActions( [
			{ type: 'number', wikitext: '\n# First', status: 'ready' },
			{ type: 'reference', wikitext: '<ref>Ref 1</ref>', status: 'ready' },
			{ type: 'category', wikitext: '\n[[Category:Science]]', status: 'ready' }
		] );

		expect( textarea.value ).toContain( '\n# First' );
		expect( textarea.value ).toContain( '<ref>Ref 1</ref>' );
		expect( textarea.value ).toContain( '[[Category:Science]]' );
	} );

	it( 'caps the undo stack at 50 snapshots', async () => {
		const textarea = makeTextarea( '' );
		global.$ = () => textarea;
		const { executor } = makeExecutor();

		for ( let i = 0; i < 55; i++ ) {
			await executor.executeActions( [
				{ type: 'insert_text', wikitext: 'x', status: 'ready' }
			] );
		}
		expect( executor.undoStack ).toHaveLength( 50 );
	} );
} );

describe( 'save and preview', () => {
	it( 'sets the edit summary and clicks the save button', async () => {
		const clicks = [];
		const summaries = [];
		const bySelector = {
			'#wpSave': { length: 1, trigger: ( event ) => clicks.push( event ) },
			'#wpSummary': { val: ( value ) => summaries.push( value ) }
		};
		global.$ = ( selector ) => bySelector[ selector ] || { length: 0 };
		const { executor, feedback } = makeExecutor();

		await executor.executeActions( [
			{ type: 'save', summary: 'minor edit', status: 'ready', feedback: 'saving' }
		] );

		expect( summaries ).toEqual( [ 'minor edit' ] );
		expect( clicks ).toEqual( [ 'click' ] );
		expect( feedback ).toContain( 'saving' );
	} );

	it( 'reports an error when saving without an open editor', async () => {
		const { executor, errors } = makeExecutor();
		await executor.executeActions( [ { type: 'save', status: 'ready' } ] );
		expect( errors ).toContain( 'wandavoice-error-noeditor' );
	} );

	it( 'clicks the preview button', async () => {
		const clicks = [];
		global.$ = ( selector ) => selector === '#wpPreview' ?
			{ length: 1, trigger: ( event ) => clicks.push( event ) } :
			{ length: 0 };
		const { executor } = makeExecutor();

		await executor.executeActions( [ { type: 'preview', status: 'ready' } ] );
		expect( clicks ).toEqual( [ 'click' ] );
	} );

	it( 'announces control actions without touching the page', async () => {
		const { executor, feedback } = makeExecutor();
		await executor.executeActions( [
			{ type: 'cancel', status: 'ready', feedback: 'cancelled' }
		] );
		expect( feedback ).toContain( 'cancelled' );
		expect( global.window.location.href ).toBe( '' );
	} );
} );
