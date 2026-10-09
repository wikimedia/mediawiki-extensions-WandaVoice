'use strict';

/**
 * End-to-end user journey simulation testing for WandaVoice.
 *
 * Simulates realistic hands-free voice interactions by a human editor across:
 * 1. Wikitext editor creation and smart editing workflow
 * 2. VisualEditor rich-text formatting and link/reference workflow
 * 3. Error recovery and feedback earcons
 */

let panel;
let props;
let recognizers;
let editorState;
let textareaMock;
let saveMock;
let config;
let originalConfigGet;
let originalJQuery;

function flushPromises() {
	return new Promise( ( resolve ) => {
		setTimeout( resolve, 10 );
	} );
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

function makeTextareaMock( initialValue = '' ) {
	let value = initialValue;
	let caret = value.length;
	let selection = '';

	return {
		length: 1,
		getValue: () => value,
		getSelectionText: () => selection,
		getCaret: () => caret,
		textSelection: function ( method, arg ) {
			switch ( method ) {
				case 'getContents':
					return value;
				case 'setContents':
					value = arg;
					caret = value.length;
					return this;
				case 'getSelection':
					return selection;
				case 'getCaretPosition':
					return caret;
				case 'setSelection':
					caret = arg.start;
					selection = value.slice( arg.start, arg.end );
					return this;
				case 'replaceSelection':
					value = value.slice( 0, caret ) + arg + value.slice( caret + selection.length );
					caret = caret + arg.length;
					selection = '';
					return this;
				case 'encapsulateSelection':
					if ( selection ) {
						value = value.slice( 0, caret ) + arg.pre + selection + arg.post +
							value.slice( caret + selection.length );
					} else {
						value = value + arg.pre + arg.post;
					}
					return this;
				case 'scrollToCaretPosition':
					return this;
				default:
					return this;
			}
		}
	};
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

	textareaMock = makeTextareaMock( '' );
	saveMock = { length: 1, trigger: jest.fn() };
	editorState = { summary: '' };

	originalJQuery = global.$;
	global.$ = ( selector ) => {
		if ( typeof selector === 'function' ) {
			selector();
			return;
		}
		if ( selector === '#wpTextbox1' ) {
			return textareaMock;
		}
		if ( selector === '#wpSave' ) {
			return saveMock;
		}
		if ( selector === '#wpSummary' ) {
			return {
				val: ( v ) => {
					if ( v !== undefined ) {
						editorState.summary = v;
					}
					return editorState.summary;
				}
			};
		}
		return { length: 0 };
	};

	originalConfigGet = global.mw.config.get;
	config = {
		useLLM: false,
		recognitionEngine: 'browser',
		wakePhrase: 'wanda',
		wakeSensitivity: 0.7,
		continuousMode: true,
		audioFeedback: true,
		customCommands: {}
	};
	global.mw.config.get = ( key ) => key === 'wgWandaVoice' ? config : originalConfigGet( key );

	global.window.SpeechRecognition = class {
		constructor() {
			this.start = jest.fn();
			this.abort = jest.fn();
			recognizers.push( this );
		}
	};
	global.window.speechSynthesis = {
		speak: jest.fn(),
		cancel: jest.fn()
	};
	global.SpeechSynthesisUtterance = function ( text ) {
		this.text = text;
	};
	global.document = {
		createElement: () => ( {} ),
		body: { appendChild: jest.fn(), classList: { add: jest.fn() } }
	};
	delete global.window.ve;
} );

afterEach( () => {
	global.mw.config.get = originalConfigGet;
	global.$ = originalJQuery;
	delete global.window.SpeechRecognition;
	delete global.window.speechSynthesis;
	delete global.SpeechSynthesisUtterance;
	delete global.document;
	delete global.window.ve;
	jest.dontMock( 'vue' );
	jest.dontMock( '../../resources/components/VoicePanel.vue' );
} );

describe( 'User Journey: Hands-free article editing in Wikitext editor', () => {
	it( 'executes complete user workflow from heading creation to search and replace and save', async () => {
		loadInterface();
		props.onToggleListening();

		// 1. User says wake phrase + creates section heading
		hear( 'Wanda, create heading level 2 Early Life' );
		await flushPromises();
		expect( textareaMock.getValue() ).toContain( '== Early Life ==' );
		expect( panel.setFeedback ).toHaveBeenLastCalledWith( 'wandavoice-feedback-inserted' );

		// 2. User dictates bullet point
		hear( 'Wanda, create bullet point Born in Germany.' );
		await flushPromises();
		expect( textareaMock.getValue() ).toContain( '* Born in Germany.' );

		// 3. User inserts internal wiki link with label
		hear( 'Wanda, insert link to Albert Einstein labeled Renowned Physicist' );
		await flushPromises();
		expect( textareaMock.getValue() ).toContain( '[[Albert Einstein|Renowned Physicist]]' );

		// 4. User adds citation reference
		hear( 'Wanda, create reference Nobel Prize Archives' );
		await flushPromises();
		expect( textareaMock.getValue() ).toContain( '<ref>Nobel Prize Archives</ref>' );

		// 5. User selects previous sentence
		hear( 'Wanda, select previous sentence' );
		await flushPromises();
		expect( panel.setFeedback ).toHaveBeenLastCalledWith( 'wandavoice-feedback-selected-sentence' );
		expect( textareaMock.getSelectionText().length ).toBeGreaterThan( 0 );

		// 6. User moves cursor to end of document
		hear( 'Wanda, go to end of document' );
		await flushPromises();
		expect( panel.setFeedback ).toHaveBeenLastCalledWith( 'wandavoice-feedback-cursor-moved' );
		expect( textareaMock.getCaret() ).toBe( textareaMock.getValue().length );

		// 7. User performs text replacement
		hear( 'Wanda, replace Germany with Ulm, Germany' );
		await flushPromises();
		expect( textareaMock.getValue() ).toContain( 'Born in Ulm, Germany' );
		expect( panel.setFeedback ).toHaveBeenLastCalledWith( 'wandavoice-feedback-replaced:Germany|Ulm, Germany' );

		// 8. User selects all
		hear( 'Wanda, select all text' );
		await flushPromises();
		expect( panel.setFeedback ).toHaveBeenLastCalledWith( 'wandavoice-feedback-selected-all' );
		expect( textareaMock.getSelectionText() ).toBe( textareaMock.getValue() );

		// 9. User saves changes with custom edit summary
		hear( 'Wanda, save changes with summary Added early life biography' );
		await flushPromises();
		expect( editorState.summary ).toBe( 'Added early life biography' );
		expect( saveMock.trigger ).toHaveBeenCalledWith( 'click' );
		expect( panel.setFeedback ).toHaveBeenLastCalledWith( 'wandavoice-feedback-saved' );
	} );
} );

describe( 'User Journey: Rich-text authoring in VisualEditor', () => {
	function setupVisualEditorMock( initialDocText = 'Initial introduction. Early research.' ) {
		let docText = initialDocText;
		const commandsExecuted = [];
		const insertedContent = [];
		const annotations = [];
		let linearSelection = { start: 0, end: 0 };

		const fragment = {
			insertContent: ( content ) => {
				insertedContent.push( content );
			},
			annotateContent: ( method, style ) => {
				annotations.push( [ method, style ] );
			},
			getRange: () => ( { isCollapsed: () => true, start: docText.length } ),
			selectAll: () => {
				linearSelection = { start: 0, end: docText.length };
			},
			selectPreviousSentence: () => {
				linearSelection = { start: 21, end: 36 };
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
			undo: jest.fn()
		};

		const surface = {
			getModel: () => model
		};

		const target = {
			getSurface: () => surface,
			executeCommand: ( cmd ) => commandsExecuted.push( cmd )
		};

		global.window.ve = {
			init: { target },
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
			target,
			commandsExecuted,
			insertedContent,
			annotations,
			getDocText: () => docText,
			getSelection: () => linearSelection
		};
	}

	it( 'executes complete VE editing workflow with annotations and commands', async () => {
		const veMock = setupVisualEditorMock();
		loadInterface();
		props.onToggleListening();

		// 1. User creates a heading
		hear( 'Wanda, create heading level 3 Discoveries' );
		await flushPromises();
		expect( veMock.commandsExecuted ).toContain( 'heading3' );
		expect( veMock.insertedContent ).toContain( 'Discoveries' );

		// 2. User creates a list item
		hear( 'Wanda, create bullet point General Relativity' );
		await flushPromises();
		expect( veMock.commandsExecuted ).toContain( 'bullet' );
		expect( veMock.insertedContent ).toContain( 'General Relativity' );

		// 3. User creates numbered list
		hear( 'Wanda, create numbered list Special Relativity' );
		await flushPromises();
		expect( veMock.commandsExecuted ).toContain( 'number' );
		expect( veMock.insertedContent ).toContain( 'Special Relativity' );

		// 4. User inserts internal link with annotations
		hear( 'Wanda, insert link to Physics labeled Modern Physics' );
		await flushPromises();
		expect( veMock.insertedContent ).toContain( 'Modern Physics' );
		const hasInternal = veMock.annotations.some( ( [ m, a ] ) => m === 'set' &&
			a && a.name === 'MWInternalLinkAnnotation' && a.element.attributes.title === 'Physics' );
		expect( hasInternal ).toBe( true );

		// 5. User adds external reference
		hear( 'Wanda, insert external link https://nobelprize.org labeled Nobel Prize Site' );
		await flushPromises();
		const hasExternal = veMock.annotations.some( ( [ m, a ] ) => m === 'set' &&
			a && a.name === 'MWExternalLinkAnnotation' && a.element.attributes.href === 'https://nobelprize.org' );
		expect( hasExternal ).toBe( true );

		// 6. User triggers citation dialog
		hear( 'Wanda, create reference Primary Sources' );
		await flushPromises();
		expect( veMock.commandsExecuted ).toContain( 'reference' );

		// 7. User triggers template / transclusion inspector
		hear( 'Wanda, add citation needed' );
		await flushPromises();
		expect( veMock.commandsExecuted ).toContain( 'transclusion' );

		// 8. User applies blockquote
		hear( 'Wanda, make this blockquote' );
		await flushPromises();
		expect( veMock.commandsExecuted ).toContain( 'blockquote' );

		// 9. User replaces text
		hear( 'Wanda, replace introduction with Overview' );
		await flushPromises();
		expect( veMock.getDocText() ).toContain( 'Initial Overview' );

		// 10. User selects previous sentence
		hear( 'Wanda, select previous sentence' );
		await flushPromises();
		expect( veMock.getSelection() ).toEqual( { start: 21, end: 36 } );

		// 11. User selects all
		hear( 'Wanda, select all' );
		await flushPromises();
		expect( veMock.getSelection().end ).toBeGreaterThan( 0 );

		// 12. User saves
		hear( 'Wanda, save page' );
		await flushPromises();
		expect( veMock.commandsExecuted ).toContain( 'showSave' );
	} );
} );

describe( 'User Journey: Error resilience and user feedback', () => {
	it( 'provides clear spoken feedback when trying to replace nonexistent text', async () => {
		textareaMock = makeTextareaMock( 'Short article text.' );
		loadInterface();
		props.onToggleListening();

		hear( 'Wanda, replace dinosaurs with birds' );
		await flushPromises();

		expect( panel.setFeedback ).toHaveBeenLastCalledWith(
			'wandavoice-feedback-replace-not-found:dinosaurs'
		);
		expect( textareaMock.getValue() ).toBe( 'Short article text.' );
	} );

	it( 'announces error when attempting edit without an active editor', async () => {
		global.$ = ( selector ) => {
			if ( typeof selector === 'function' ) {
				selector();
				return;
			}
			return { length: 0 };
		};
		loadInterface();
		props.onToggleListening();

		hear( 'Wanda, make this bold' );
		await flushPromises();

		expect( panel.setError ).toHaveBeenCalledWith( 'wandavoice-error-noeditor' );
	} );
} );
