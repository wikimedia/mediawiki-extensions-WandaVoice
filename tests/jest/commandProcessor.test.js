'use strict';

const CommandProcessor = require( '../../resources/commandProcessor.js' );

function makeProcessor( configOverrides ) {
	const config = Object.assign( {
		useLLM: false,
		showThinking: false,
		language: 'en-US',
		customCommands: {},
		offlineCommands: [ 'save', 'preview', 'undo', 'cancel', 'stop listening', 'help' ]
	}, configOverrides );
	return new CommandProcessor( config );
}

describe( 'local command grammar', () => {
	it( 'parses navigation commands', async () => {
		const result = await makeProcessor().process( 'Navigate to the Main Page' );
		expect( result.actions ).toHaveLength( 1 );
		expect( result.actions[ 0 ].type ).toBe( 'navigate' );
		expect( result.actions[ 0 ].target ).toBe( 'main page' );
		expect( result.actions[ 0 ].url ).toBe( '/wiki/main page' );
	} );

	it( 'parses move and rename page commands', async () => {
		const result = await makeProcessor().process( 'change the title of the page to Messi to Messi the goat' );
		expect( result.actions[ 0 ].type ).toBe( 'navigate' );
		expect( result.actions[ 0 ].url ).toContain( 'Special:MovePage/messi' );
	} );

	it( 'parses conversational edit and add content queries', async () => {
		const result = await makeProcessor().process( 'can you add more content to this page' );
		expect( result.actions[ 0 ].type ).toBe( 'navigate' );
		expect( result.actions[ 0 ].url ).toContain( 'action=edit' );
	} );

	it( 'parses search commands', async () => {
		const result = await makeProcessor().process( 'search for quantum physics' );
		expect( result.actions[ 0 ].type ).toBe( 'search' );
		expect( result.actions[ 0 ].query ).toBe( 'quantum physics' );
	} );

	it( 'parses section edit commands with numbers', async () => {
		const result = await makeProcessor().process( 'edit section 2' );
		expect( result.actions[ 0 ].type ).toBe( 'edit_section' );
		expect( result.actions[ 0 ].section ).toBe( 2 );
		expect( result.actions[ 0 ].target ).toBe( 'Test_Page' );
	} );

	it( 'parses formatting commands into selection wrappers', async () => {
		const result = await makeProcessor().process( 'make this bold' );
		expect( result.actions[ 0 ].type ).toBe( 'format' );
		expect( result.actions[ 0 ].wrap ).toEqual( { pre: "'''", post: "'''" } );
	} );

	it( 'generates heading wikitext with the requested level', async () => {
		const result = await makeProcessor().process( 'create heading level 3 called history' );
		expect( result.actions[ 0 ].wikitext ).toBe( '\n=== History ===\n' );
	} );

	it( 'generates link wikitext with a capitalised title', async () => {
		const result = await makeProcessor().process( 'insert link to paris' );
		expect( result.actions[ 0 ].wikitext ).toBe( '[[Paris]]' );
	} );

	it( 'maps "citation needed" to the template', async () => {
		const result = await makeProcessor().process( 'add citation needed' );
		expect( result.actions[ 0 ].type ).toBe( 'template' );
		expect( result.actions[ 0 ].wikitext ).toBe( '{{citation needed}}' );
	} );

	it( 'generates bullet list wikitext', async () => {
		const result = await makeProcessor().process( 'create bullet point First item' );
		expect( result.actions[ 0 ].wikitext ).toBe( '\n* first item' );
	} );

	it( 'parses save commands with an edit summary', async () => {
		const result = await makeProcessor().process( 'save changes with summary fixed typo' );
		expect( result.actions[ 0 ].type ).toBe( 'save' );
		expect( result.actions[ 0 ].summary ).toBe( 'fixed typo' );
	} );

	it( 'parses control commands', async () => {
		expect( ( await makeProcessor().process( 'undo' ) ).actions[ 0 ].type ).toBe( 'undo' );
		expect( ( await makeProcessor().process( 'cancel' ) ).actions[ 0 ].type ).toBe( 'cancel' );
		expect( ( await makeProcessor().process( 'stop listening' ) ).actions[ 0 ].type )
			.toBe( 'stop_listening' );
	} );

	it( 'expands custom command shortcuts', async () => {
		const processor = makeProcessor( {
			customCommands: { 'quick save': 'save changes with summary minor edit' }
		} );
		const result = await processor.process( 'Quick save.' );
		expect( result.actions[ 0 ].type ).toBe( 'save' );
		expect( result.actions[ 0 ].summary ).toBe( 'minor edit' );
	} );

	it( 'returns unknown when the grammar fails and the LLM is disabled', async () => {
		const result = await makeProcessor().process( 'do something inexplicable please' );
		expect( result.intent ).toBe( 'unknown' );
		expect( result.actions ).toHaveLength( 0 );
	} );

	it( 'opens the current page for editing', async () => {
		const result = await makeProcessor().process( 'edit this page' );
		expect( result.actions[ 0 ].type ).toBe( 'navigate' );
		expect( result.actions[ 0 ].url ).toBe( '/wiki/Test_Page?action=edit' );
	} );

	it( 'opens the page history', async () => {
		const result = await makeProcessor().process( 'open history' );
		expect( result.actions[ 0 ].type ).toBe( 'open_history' );
		expect( result.actions[ 0 ].url ).toBe( '/wiki/Test_Page?action=history' );
	} );

	it( 'parses preview and help', async () => {
		expect( ( await makeProcessor().process( 'show preview' ) ).actions[ 0 ].type )
			.toBe( 'preview' );
		expect( ( await makeProcessor().process( 'help' ) ).actions[ 0 ].type )
			.toBe( 'help' );
	} );

	it( 'converts spoken punctuation in type commands', async () => {
		const result = await makeProcessor().process( 'type hello comma world question mark' );
		expect( result.actions[ 0 ].type ).toBe( 'insert_text' );
		expect( result.actions[ 0 ].wikitext ).toBe( 'hello, world?' );
	} );

	it( 'parses named template insertion', async () => {
		const result = await makeProcessor().process( 'insert infobox template' );
		expect( result.actions[ 0 ].wikitext ).toBe( '{{infobox}}' );
	} );

	it( 'keeps search commands containing "and" local', async () => {
		const result = await makeProcessor().process( 'search for cats and dogs' );
		expect( result.actions[ 0 ].type ).toBe( 'search' );
		expect( result.actions[ 0 ].query ).toBe( 'cats and dogs' );
	} );

	it( 'parses diverse navigation phrasing variations', async () => {
		let res = await makeProcessor().process( 'go to Physics' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].target ).toBe( 'physics' );

		res = await makeProcessor().process( 'visit Albert Einstein' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );

		res = await makeProcessor().process( 'jump to Special:Version' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
	} );

	it( 'parses search variations like find and lookup', async () => {
		let res = await makeProcessor().process( 'find relativity' );
		expect( res.actions[ 0 ].type ).toBe( 'search' );
		expect( res.actions[ 0 ].query ).toBe( 'relativity' );

		res = await makeProcessor().process( 'lookup black holes' );
		expect( res.actions[ 0 ].type ).toBe( 'search' );
		expect( res.actions[ 0 ].query ).toBe( 'black holes' );
	} );

	it( 'parses expanded formatting styles (code, strikethrough, underline, blockquote)', async () => {
		let res = await makeProcessor().process( 'format as code' );
		expect( res.actions[ 0 ].style ).toBe( 'code' );
		expect( res.actions[ 0 ].wrap ).toEqual( { pre: '<code>', post: '</code>' } );

		res = await makeProcessor().process( 'strikethrough this' );
		expect( res.actions[ 0 ].style ).toBe( 'strikethrough' );

		res = await makeProcessor().process( 'underline selection' );
		expect( res.actions[ 0 ].style ).toBe( 'underline' );

		res = await makeProcessor().process( 'insert blockquote' );
		expect( res.actions[ 0 ].style ).toBe( 'blockquote' );

		res = await makeProcessor().process( 'italicize this' );
		expect( res.actions[ 0 ].style ).toBe( 'italic' );
	} );

	it( 'parses labeled links', async () => {
		const res = await makeProcessor().process( 'insert link to Paris with text City of Light' );
		expect( res.actions[ 0 ].type ).toBe( 'link' );
		expect( res.actions[ 0 ].wikitext ).toBe( '[[Paris|city of light]]' );
	} );

	it( 'parses numbered list items', async () => {
		const res = await makeProcessor().process( 'add numbered item First step' );
		expect( res.actions[ 0 ].type ).toBe( 'number' );
		expect( res.actions[ 0 ].wikitext ).toBe( '\n# first step' );
	} );

	it( 'parses table creation', async () => {
		const res = await makeProcessor().process( 'insert table' );
		expect( res.actions[ 0 ].type ).toBe( 'table' );
		expect( res.actions[ 0 ].wikitext ).toContain( '{| class="wikitable"' );
	} );

	it( 'parses references, categories and images', async () => {
		let res = await makeProcessor().process( 'add reference Journal of Science' );
		expect( res.actions[ 0 ].type ).toBe( 'reference' );
		expect( res.actions[ 0 ].wikitext ).toBe( '<ref>journal of science</ref>' );

		res = await makeProcessor().process( 'add category Physics' );
		expect( res.actions[ 0 ].type ).toBe( 'category' );
		expect( res.actions[ 0 ].wikitext ).toBe( '\n[[Category:Physics]]' );

		res = await makeProcessor().process( 'add image Example.jpg' );
		expect( res.actions[ 0 ].type ).toBe( 'image' );
		expect( res.actions[ 0 ].wikitext ).toBe( '[[File:Example.jpg|thumb|example.jpg]]' );
	} );

	it( 'converts extended spoken punctuation', async () => {
		const res = await makeProcessor().process( 'type title colon section semicolon dash hyphen open quote test close quote open paren note close paren slash backslash at sign hashtag' );
		expect( res.actions[ 0 ].wikitext ).toBe( 'title: section; - -"test"(note) / \\ @ #' );
	} );

	it( 'parses subscript, superscript, small, and big text formatting', async () => {
		let res = await makeProcessor().process( 'make subscript' );
		expect( res.actions[ 0 ].wrap ).toEqual( { pre: '<sub>', post: '</sub>' } );

		res = await makeProcessor().process( 'make superscript' );
		expect( res.actions[ 0 ].wrap ).toEqual( { pre: '<sup>', post: '</sup>' } );

		res = await makeProcessor().process( 'make small text' );
		expect( res.actions[ 0 ].wrap ).toEqual( { pre: '<small>', post: '</small>' } );

		res = await makeProcessor().process( 'make big text' );
		expect( res.actions[ 0 ].wrap ).toEqual( { pre: '<big>', post: '</big>' } );
	} );

	it( 'parses clear selection command', async () => {
		const res = await makeProcessor().process( 'clear selection' );
		expect( res.actions[ 0 ].style ).toBe( 'clear' );
		expect( res.actions[ 0 ].clear ).toBe( true );
	} );

	it( 'parses external links, redirects, math, syntax highlighting, and horizontal rules', async () => {
		let res = await makeProcessor().process( 'insert external link to https://wikipedia.org with text Wikipedia' );
		expect( res.actions[ 0 ].wikitext ).toBe( '[https://wikipedia.org wikipedia]' );

		res = await makeProcessor().process( 'create redirect to Main Page' );
		expect( res.actions[ 0 ].wikitext ).toBe( '#REDIRECT [[Main page]]' );

		res = await makeProcessor().process( 'insert horizontal rule' );
		expect( res.actions[ 0 ].wikitext ).toBe( '\n----\n' );

		res = await makeProcessor().process( 'create math x^2 + y^2' );
		expect( res.actions[ 0 ].wikitext ).toBe( '<math>x^2 + y^2</math>' );

		res = await makeProcessor().process( 'create code block hello world' );
		expect( res.actions[ 0 ].wikitext ).toContain( '<syntaxhighlight' );
	} );

	it( 'parses page creation and subpage creation commands', async () => {
		let res = await makeProcessor().process( 'create new page Quantum Physics' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].target ).toBe( 'Quantum physics' );
		expect( res.actions[ 0 ].url ).toContain( 'action=edit' );
		expect( res.actions[ 0 ].url ).toContain( 'Quantum physics' );

		res = await makeProcessor().process( 'create subpage Introduction' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].target ).toBe( 'Test_Page/Introduction' );
	} );

	it( 'parses page protection, deletion, and file upload actions', async () => {
		let res = await makeProcessor().process( 'protect this page' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].url ).toContain( 'action=protect' );

		res = await makeProcessor().process( 'delete this page' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].url ).toContain( 'action=delete' );

		res = await makeProcessor().process( 'upload file' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].target ).toBe( 'Special:Upload' );
	} );

	it( 'parses TOC, signatures, timestamps, definition lists, galleries, and preformatted text', async () => {
		let res = await makeProcessor().process( 'insert table of contents' );
		expect( res.actions[ 0 ].wikitext ).toBe( '\n__TOC__\n' );

		res = await makeProcessor().process( 'hide TOC' );
		expect( res.actions[ 0 ].wikitext ).toBe( '\n__NOTOC__\n' );

		res = await makeProcessor().process( 'add signature' );
		expect( res.actions[ 0 ].wikitext ).toBe( '~~~~' );

		res = await makeProcessor().process( 'add timestamp' );
		expect( res.actions[ 0 ].wikitext ).toBe( '~~~~~' );

		res = await makeProcessor().process( 'add term Atom definition smallest unit' );
		expect( res.actions[ 0 ].wikitext ).toBe( '\n; atom : smallest unit' );

		res = await makeProcessor().process( 'insert gallery' );
		expect( res.actions[ 0 ].wikitext ).toContain( '<gallery>' );

		res = await makeProcessor().process( 'insert preformatted text raw data' );
		expect( res.actions[ 0 ].wikitext ).toContain( '<pre>' );
	} );
} );

describe( 'dictation mode', () => {
	it( 'enters, dictates offline with spoken punctuation, and exits', async () => {
		const processor = makeProcessor();

		const enter = await processor.process( 'start dictation' );
		expect( enter.actions[ 0 ].type ).toBe( 'start_dictation' );
		expect( processor.dictationMode ).toBe( true );

		const dictated = await processor.process( 'hello world period new paragraph next line' );
		expect( dictated.actions[ 0 ].type ).toBe( 'insert_text' );
		expect( dictated.actions[ 0 ].wikitext ).toBe( 'hello world.\n\nnext line' );

		const exit = await processor.process( 'stop dictation' );
		expect( exit.actions[ 0 ].type ).toBe( 'stop_dictation' );
		expect( processor.dictationMode ).toBe( false );
	} );
} );

describe( 'LLM fallback', () => {
	it( 'sends compound commands to the wandavoice API', async () => {
		const posts = [];
		global.__apiPost = ( params ) => {
			posts.push( params );
			return Promise.resolve( {
				intent: 'edit',
				actions: [ { type: 'format', style: 'bold', wikitext: "'''photosynthesis'''", status: 'ready' } ],
				audioFeedback: 'ok',
				thinkingSteps: []
			} );
		};

		const processor = makeProcessor( { useLLM: true } );
		const result = await processor.process( 'bold the word photosynthesis then create heading process' );

		expect( posts ).toHaveLength( 1 );
		expect( posts[ 0 ].action ).toBe( 'wandavoice' );
		expect( posts[ 0 ].mode ).toBe( 'auto' );
		expect( posts[ 0 ].context ).toBe( 'Test_Page' );
		expect( result.intent ).toBe( 'edit' );
		expect( result.actions[ 0 ].wikitext ).toBe( "'''photosynthesis'''" );
	} );

	it( 'tracks dictation state from API-returned control actions', async () => {
		global.__apiPost = () => Promise.resolve( {
			intent: 'control',
			actions: [ { type: 'start_dictation', status: 'ready' } ],
			audioFeedback: ''
		} );

		const processor = makeProcessor( { useLLM: true } );
		await processor.process( 'please take a note for me' );
		expect( processor.dictationMode ).toBe( true );
	} );

	it( 'passes the showthinking flag through to the API', async () => {
		const posts = [];
		global.__apiPost = ( params ) => {
			posts.push( params );
			return Promise.resolve( { intent: 'unknown', actions: [] } );
		};

		const processor = makeProcessor( { useLLM: true, showThinking: true } );
		await processor.process( 'reorganize the article and improve it' );
		expect( posts[ 0 ].showthinking ).toBe( 1 );
	} );

	it( 'propagates API failures to the caller', async () => {
		global.__apiPost = () => Promise.reject( new Error( 'service down' ) );
		const processor = makeProcessor( { useLLM: true } );
		await expect( processor.process( 'reorganize the article and improve it' ) )
			.rejects.toThrow( 'service down' );
	} );
} );
