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
				case 'setSelection':
					textarea.caret = arg.start;
					textarea.selection = textarea.value.slice( arg.start, arg.end );
					return textarea;
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
	delete global.window.ve;
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

	it( 'selects all text in wikitext editor', async () => {
		const textarea = makeTextarea( 'Hello world' );
		global.$ = () => textarea;
		const { executor, feedback } = makeExecutor();

		await executor.executeActions( [
			{ type: 'select', scope: 'all', status: 'ready', feedback: 'selected all' }
		] );

		expect( textarea.calls ).toContainEqual(
			[ 'setSelection', { start: 0, end: 11 } ]
		);
		expect( feedback ).toContain( 'selected all' );
	} );

	it( 'selects previous sentence in wikitext editor', async () => {
		const textarea = makeTextarea( 'First sentence. Second sentence here. ' );
		textarea.caret = textarea.value.length;
		global.$ = () => textarea;
		const { executor } = makeExecutor();

		await executor.executeActions( [
			{ type: 'select', scope: 'previous_sentence', target: 'sentence', status: 'ready' }
		] );

		expect( textarea.calls ).toContainEqual(
			[ 'setSelection', { start: 16, end: 37 } ]
		);
	} );

	it( 'moves cursor to start and end in wikitext editor', async () => {
		const textarea = makeTextarea( 'Hello world' );
		global.$ = () => textarea;
		const { executor } = makeExecutor();

		await executor.executeActions( [
			{ type: 'cursor', position: 'start', status: 'ready' },
			{ type: 'cursor', position: 'end', status: 'ready' }
		] );

		expect( textarea.calls ).toContainEqual( [ 'setSelection', { start: 0, end: 0 } ] );
		expect( textarea.calls ).toContainEqual( [ 'setSelection', { start: 11, end: 11 } ] );
	} );

	it( 'replaces text in wikitext editor and reports if not found', async () => {
		const textarea = makeTextarea( 'The quick brown fox' );
		global.$ = () => textarea;
		const { executor, feedback } = makeExecutor();

		await executor.executeActions( [
			{
				type: 'replace_text',
				find: 'brown',
				replacement: 'red',
				status: 'ready',
				feedback: 'replaced'
			}
		] );

		expect( textarea.value ).toBe( 'The quick red fox' );
		expect( feedback ).toContain( 'replaced' );

		await executor.executeActions( [
			{ type: 'replace_text', find: 'missing', replacement: 'new', status: 'ready' }
		] );

		expect( feedback ).toContain( 'wandavoice-feedback-replace-not-found:missing' );
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

describe( 'VisualEditor actions', () => {
	function makeVeSurface() {
		const insertedContent = [];
		const annotations = [];
		const commandsExecuted = [];
		let undoCount = 0;
		let linearSelection = null;
		let docText = 'First sentence. Second sentence here.';

		const fragment = {
			insertContent: ( content ) => insertedContent.push( content ),
			annotateContent: ( method, style ) => annotations.push( [ method, style ] ),
			clearAnnotations: () => annotations.push( [ 'clear' ] ),
			getText: () => 'selected text',
			getRange: () => ( { isCollapsed: () => true, start: docText.length } ),
			getTextBefore: () => docText,
			selectAll: () => {
				linearSelection = { start: 0, end: docText.length };
			},
			selectPreviousSentence: () => {
				linearSelection = { start: 16, end: 36 };
			},
			collapseToStart: () => ( {
				select: () => {
					linearSelection = { start: 0, end: 0 };
				}
			} ),
			collapseToEnd: () => ( {
				select: () => {
					linearSelection = { start: docText.length, end: docText.length };
				}
			} )
		};

		const doc = {
			getText: ( range ) => range ? docText.slice( range.start, range.end ) : docText,
			getLength: () => docText.length
		};

		const model = {
			getFragment: () => fragment,
			getDocument: () => doc,
			setLinearSelection: ( range ) => {
				linearSelection = range;
			},
			getLinearFragment: ( range ) => ( {
				insertContent: ( content ) => {
					docText = docText.slice( 0, range.start ) + content +
						docText.slice( range.end );
					insertedContent.push( content );
				}
			} ),
			undo: () => {
				undoCount++;
			}
		};

		const surface = {
			getModel: () => model
		};

		const target = {
			getSurface: () => surface,
			executeCommand: ( cmd ) => commandsExecuted.push( cmd )
		};

		global.window.ve = {
			init: {
				target: target
			},
			Range: function ( start, end ) {
				this.start = start;
				this.end = end;
			},
			dm: {
				MWInternalLinkAnnotation: function ( element ) {
					this.name = 'MWInternalLinkAnnotation';
					this.element = element;
				},
				MWExternalLinkAnnotation: function ( element ) {
					this.name = 'MWExternalLinkAnnotation';
					this.element = element;
				}
			}
		};

		return {
			surface,
			fragment,
			model,
			target,
			insertedContent,
			annotations,
			commandsExecuted,
			getLinearSelection: () => linearSelection,
			getDocText: () => docText,
			getUndoCount: () => undoCount
		};
	}

	it( 'inserts text and wikitext into VisualEditor surface', async () => {
		const { executor, feedback } = makeExecutor();
		const veMock = makeVeSurface();

		await executor.executeActions( [
			{ type: 'insert_text', wikitext: 'world', status: 'ready', feedback: 'inserted text' },
			{ type: 'link', wikitext: '[[Paris]]', status: 'ready', feedback: 'inserted link' }
		] );

		expect( veMock.insertedContent ).toEqual( [ ' world', '[[Paris]]' ] );
		expect( feedback ).toContain( 'inserted text' );
		expect( feedback ).toContain( 'inserted link' );
	} );

	it( 'applies formatting in VisualEditor', async () => {
		const { executor } = makeExecutor();
		const veMock = makeVeSurface();

		await executor.executeActions( [
			{ type: 'format', style: 'bold', status: 'ready' },
			{ type: 'format', style: 'italic', status: 'ready' },
			{ type: 'format', style: 'clear', clear: true, status: 'ready' }
		] );

		expect( veMock.annotations ).toEqual( [
			[ 'set', 'bold' ],
			[ 'set', 'italic' ],
			[ 'clear' ]
		] );
	} );

	it( 'creates headings, bullet and numbered lists in VisualEditor', async () => {
		const { executor } = makeExecutor();
		const veMock = makeVeSurface();

		await executor.executeActions( [
			{ type: 'heading', level: 3, text: 'Ancient Rome', status: 'ready' },
			{ type: 'bullet', text: 'First item', status: 'ready' },
			{ type: 'number', text: 'Step one', status: 'ready' }
		] );

		expect( veMock.commandsExecuted ).toContain( 'heading3' );
		expect( veMock.commandsExecuted ).toContain( 'bullet' );
		expect( veMock.commandsExecuted ).toContain( 'number' );
		expect( veMock.insertedContent ).toContain( 'Ancient Rome' );
		expect( veMock.insertedContent ).toContain( 'First item' );
		expect( veMock.insertedContent ).toContain( 'Step one' );
	} );

	it( 'applies blockquote, code, and other styles in VisualEditor', async () => {
		const { executor } = makeExecutor();
		const veMock = makeVeSurface();

		await executor.executeActions( [
			{ type: 'format', style: 'blockquote', status: 'ready' },
			{ type: 'format', style: 'code', status: 'ready' },
			{ type: 'format', style: 'underline', status: 'ready' }
		] );

		expect( veMock.commandsExecuted ).toContain( 'blockquote' );
		expect( veMock.annotations ).toContainEqual( [ 'set', 'code' ] );
		expect( veMock.annotations ).toContainEqual( [ 'set', 'underline' ] );
	} );

	it( 'creates internal and external links using VE annotations', async () => {
		const { executor } = makeExecutor();
		const veMock = makeVeSurface();

		await executor.executeActions( [
			{ type: 'link', target: 'Paris', text: 'Capital of France', status: 'ready' },
			{
				type: 'link',
				url: 'https://example.org',
				text: 'Example site',
				isExternal: true,
				status: 'ready'
			}
		] );

		expect( veMock.insertedContent ).toContain( 'Capital of France' );
		expect( veMock.insertedContent ).toContain( 'Example site' );
		const hasInternal = veMock.annotations.some( ( [ method, ann ] ) => method === 'set' &&
			ann && ann.name === 'MWInternalLinkAnnotation' &&
			ann.element.attributes.title === 'Paris' );
		expect( hasInternal ).toBe( true );
		const hasExternal = veMock.annotations.some( ( [ method, ann ] ) => method === 'set' &&
			ann && ann.name === 'MWExternalLinkAnnotation' &&
			ann.element.attributes.href === 'https://example.org' );
		expect( hasExternal ).toBe( true );
	} );

	it( 'triggers citation and template inspectors in VisualEditor', async () => {
		const { executor } = makeExecutor();
		const veMock = makeVeSurface();

		await executor.executeActions( [
			{ type: 'reference', text: 'Ref content', status: 'ready' },
			{ type: 'template', name: 'citation needed', status: 'ready' }
		] );

		expect( veMock.commandsExecuted ).toContain( 'reference' );
		expect( veMock.commandsExecuted ).toContain( 'transclusion' );
	} );

	it( 'selects text, navigates cursor, and replaces text in VisualEditor', async () => {
		const { executor, feedback } = makeExecutor();
		const veMock = makeVeSurface();

		await executor.executeActions( [
			{ type: 'select', scope: 'all', status: 'ready' }
		] );
		expect( veMock.getLinearSelection() ).toEqual( { start: 0, end: 37 } );

		await executor.executeActions( [
			{ type: 'select', scope: 'previous_sentence', target: 'sentence', status: 'ready' }
		] );
		expect( veMock.getLinearSelection() ).toEqual( { start: 16, end: 36 } );

		await executor.executeActions( [
			{ type: 'cursor', position: 'start', status: 'ready' }
		] );
		expect( veMock.getLinearSelection() ).toEqual( { start: 0, end: 0 } );

		await executor.executeActions( [
			{ type: 'cursor', position: 'end', status: 'ready' }
		] );
		expect( veMock.getLinearSelection() ).toEqual( { start: 37, end: 37 } );

		await executor.executeActions( [
			{
				type: 'replace_text',
				find: 'Second',
				replacement: 'Next',
				status: 'ready',
				feedback: 'replaced ve'
			}
		] );
		expect( veMock.getDocText() ).toContain( 'Next sentence' );
		expect( feedback ).toContain( 'replaced ve' );
	} );

	it( 'triggers save, preview, and undo in VisualEditor', async () => {
		const { executor, feedback } = makeExecutor();
		const veMock = makeVeSurface();

		await executor.executeActions( [
			{ type: 'save', status: 'ready', feedback: 'saving ve' },
			{ type: 'preview', status: 'ready', feedback: 'previewing ve' },
			{ type: 'undo', status: 'ready', feedback: 'undone ve' }
		] );

		expect( veMock.commandsExecuted ).toEqual( [ 'showSave', 'showChanges' ] );
		expect( veMock.getUndoCount() ).toBe( 1 );
		expect( feedback ).toContain( 'saving ve' );
		expect( feedback ).toContain( 'previewing ve' );
		expect( feedback ).toContain( 'undone ve' );
	} );
} );
