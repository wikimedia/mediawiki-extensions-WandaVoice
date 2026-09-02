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
		expect( result.actions[ 0 ].target ).toBe( 'Main Page' );
		expect( result.actions[ 0 ].url ).toBe( '/wiki/Main Page' );
	} );

	it( 'parses move and rename page commands', async () => {
		const result = await makeProcessor().process( 'change the title of the page to Messi to Messi the goat' );
		expect( result.actions[ 0 ].type ).toBe( 'navigate' );
		expect( result.actions[ 0 ].url ).toBe( '/wiki/Special:MovePage/Messi?wpNewTitle=Messi+the+goat' );
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
		expect( result.actions[ 0 ].wikitext ).toBe( '\n=== history ===\n' );
	} );

	it( 'generates link wikitext with the original title', async () => {
		const result = await makeProcessor().process( 'insert link to paris' );
		expect( result.actions[ 0 ].wikitext ).toBe( '[[paris]]' );
	} );

	it( 'maps "citation needed" to the template', async () => {
		const result = await makeProcessor().process( 'add citation needed' );
		expect( result.actions[ 0 ].type ).toBe( 'template' );
		expect( result.actions[ 0 ].wikitext ).toBe( '{{citation needed}}' );
	} );

	it( 'generates bullet list wikitext', async () => {
		const result = await makeProcessor().process( 'create bullet point First item' );
		expect( result.actions[ 0 ].wikitext ).toBe( '\n* First item' );
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
		expect( res.actions[ 0 ].target ).toBe( 'Physics' );

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
		expect( res.actions[ 0 ].wikitext ).toBe( '[[Paris|City of Light]]' );
	} );

	it( 'parses numbered list items', async () => {
		const res = await makeProcessor().process( 'add numbered item First step' );
		expect( res.actions[ 0 ].type ).toBe( 'number' );
		expect( res.actions[ 0 ].wikitext ).toBe( '\n# First step' );
	} );

	it( 'parses table creation', async () => {
		const res = await makeProcessor().process( 'insert table' );
		expect( res.actions[ 0 ].type ).toBe( 'table' );
		expect( res.actions[ 0 ].wikitext ).toContain( '{| class="wikitable"' );
	} );

	it( 'parses references, categories and images', async () => {
		let res = await makeProcessor().process( 'add reference Journal of Science' );
		expect( res.actions[ 0 ].type ).toBe( 'reference' );
		expect( res.actions[ 0 ].wikitext ).toBe( '<ref>Journal of Science</ref>' );

		res = await makeProcessor().process( 'add category Physics' );
		expect( res.actions[ 0 ].type ).toBe( 'category' );
		expect( res.actions[ 0 ].wikitext ).toBe( '\n[[Category:Physics]]' );

		res = await makeProcessor().process( 'add image Example.jpg' );
		expect( res.actions[ 0 ].type ).toBe( 'image' );
		expect( res.actions[ 0 ].wikitext ).toBe( '[[File:Example.jpg|thumb|Example.jpg]]' );
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
		expect( res.actions[ 0 ].wikitext ).toBe( '[https://wikipedia.org Wikipedia]' );

		res = await makeProcessor().process( 'create redirect to Main Page' );
		expect( res.actions[ 0 ].wikitext ).toBe( '#REDIRECT [[Main Page]]' );

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
		expect( res.actions[ 0 ].target ).toBe( 'Quantum Physics' );
		expect( res.actions[ 0 ].url ).toContain( 'action=edit' );
		expect( res.actions[ 0 ].url ).toContain( 'Quantum Physics' );

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
		expect( res.actions[ 0 ].wikitext ).toBe( '\n; Atom : smallest unit' );

		res = await makeProcessor().process( 'insert gallery' );
		expect( res.actions[ 0 ].wikitext ).toContain( '<gallery>' );

		res = await makeProcessor().process( 'insert preformatted text raw data' );
		expect( res.actions[ 0 ].wikitext ).toContain( '<pre>' );
	} );
} );

describe( 'case-preserving local parsing regressions', () => {
	it.each( [
		[ 'NaViGaTe To iPhone: NASA?', { type: 'navigate', target: 'iPhone: NASA?', url: '/wiki/iPhone: NASA?' } ],
		[ 'SEARCH FOR Café NASA?', { type: 'search', query: 'Café NASA?', url: '/wiki/Special:Search?search=Caf%C3%A9+NASA%3F' } ],
		[ 'CREATE NEW PAGE iPhone NASA', { type: 'navigate', target: 'iPhone NASA', url: '/wiki/iPhone NASA?action=edit' } ],
		[ 'CREATE SUBPAGE iOS FAQ', { type: 'navigate', target: 'Test_Page/iOS FAQ', url: '/wiki/Test_Page/iOS FAQ?action=edit' } ],
		[ 'SAVE CHANGES WITH SUMMARY Fix NASA typo: Café!', { type: 'save', summary: 'Fix NASA typo: Café!' } ],
		[ 'PUBLISH WITH SUMMARY NASA?', { type: 'save', summary: 'NASA?' } ]
	] )( 'preserves arguments in %s', async ( transcript, action ) => {
		const processor = makeProcessor();

		const result = await processor.process( transcript );

		expect( result.actions ).toHaveLength( 1 );
		expect( result.actions[ 0 ] ).toMatchObject( action );
	} );

	it.each( [
		[ 'type Hello NASA.', 'Hello NASA.' ],
		[ 'TyPe Café — Ελληνικά, 東京! 🚀', 'Café — Ελληνικά, 東京! 🚀' ],
		[ 'WRITE Hello NASA COMMA Café QUESTION MARK', 'Hello NASA, Café?' ],
		[ 'DICTATE NASA NEW LINE iPhone', 'NASA\niPhone' ],
		[ 'INSERT TEXT NASA NEW PARAGRAPH Café', 'NASA\n\nCafé' ],
		[ 'INSERT LINK TO iPhone WITH TEXT NASA: Read Me!', '[[iPhone|NASA: Read Me!]]' ],
		[ 'LINK TO iPhone', '[[iPhone]]' ],
		[ 'CREATE REDIRECT TO iPhone NASA', '#REDIRECT [[iPhone NASA]]' ],
		[ 'REDIRECT THIS PAGE TO iPhone', '#REDIRECT [[iPhone]]' ],
		[ 'CREATE HEADING LEVEL 3 CALLED iPhone NASA?', '\n=== iPhone NASA? ===\n' ],
		[ 'ADD LEVEL 4 HEADING Café NASA!', '\n==== Café NASA! ====\n' ],
		[ 'ADD BULLET POINT NASA: Ready!', '\n* NASA: Ready!' ],
		[ 'BULLET POINT iPhone.', '\n* iPhone.' ],
		[ 'ADD NUMBERED ITEM First NASA step.', '\n# First NASA step.' ],
		[ 'NUMBERED POINT iPhone.', '\n# iPhone.' ],
		[ 'ADD REFERENCE NASA (2026): Café.', '<ref>NASA (2026): Café.</ref>' ],
		[ 'ADD CATEGORY iPhone NASA', '\n[[Category:iPhone NASA]]' ],
		[ 'EMBED IMAGE iPhone_NASA.SVG', '[[File:iPhone_NASA.SVG|thumb|iPhone_NASA.SVG]]' ],
		[ 'INSERT TEMPLATE Infobox NASA', '{{Infobox NASA}}' ],
		[ 'USE iPhone NASA TEMPLATE', '{{iPhone NASA}}' ],
		[ 'INSERT TEMPLATE CiteWeb|URL=https://Example.org/Case?ID=AbC', '{{CiteWeb|URL=https://Example.org/Case?ID=AbC}}' ],
		[ 'ADD DEFINITION FOR NASA IS Space Agency.', '\n; NASA : Space Agency.' ],
		[ 'ADD TERM iPhone DEFINITION Apple Device.', '\n; iPhone : Apple Device.' ],
		[ 'INSERT PREFORMATTED TEXT NASA: value;', '\n<pre>\nNASA: value;\n</pre>\n' ],
		[ 'CREATE CODE BLOCK const NASA = "Café";', '\n<syntaxhighlight lang="text">\nconst NASA = "Café";\n</syntaxhighlight>\n' ],
		[ 'CREATE MATH EQUATION E = Mc^2 + \\Gamma;', '<math>E = Mc^2 + \\Gamma;</math>' ]
	] )( 'preserves content in %s', async ( transcript, wikitext ) => {
		const processor = makeProcessor();

		const result = await processor.process( transcript );

		expect( result.actions ).toHaveLength( 1 );
		expect( result.actions[ 0 ].wikitext ).toBe( wikitext );
	} );

	it.each( [
		'https://Example.org/CaseSensitive/Path?Token=AbC%2FDeF#NASA',
		'https://Example.org/CaseSensitive?',
		'https://Example.org/Path.',
		'https://Example.org/Path?Q=NASA!'
	] )( 'preserves the complete external URL %s', async ( url ) => {
		const processor = makeProcessor();

		const result = await processor.process( 'INSERT EXTERNAL LINK TO ' + url );

		expect( result.actions[ 0 ] ).toMatchObject( {
			type: 'link', wikitext: '[' + url + ']'
		} );
	} );

	it( 'preserves both a case-sensitive external URL and its label', async () => {
		const processor = makeProcessor();

		const result = await processor.process( 'ADD EXTERNAL LINK TO https://Example.org/API?Key=AbC WITH TEXT NASA: Café?' );

		expect( result.actions[ 0 ].wikitext )
			.toBe( '[https://Example.org/API?Key=AbC NASA: Café?]' );
	} );

	it.each( [
		[ 'Save changes.', 'save' ],
		[ '  PUBLISH THE PAGE!  ', 'save' ],
		[ 'SHOW PREVIEW?', 'preview' ],
		[ 'UNDO LAST EDIT.', 'undo' ],
		[ 'NEVER MIND!', 'cancel' ],
		[ 'TURN OFF VOICE.', 'stop_listening' ],
		[ 'BEGIN DICTATION MODE.', 'start_dictation' ],
		[ 'END DICTATION.', 'stop_dictation' ],
		[ 'SHOW HELP!', 'help' ],
		[ 'SHOW PAGE HISTORY.', 'open_history' ],
		[ 'PROTECT THIS PAGE.', 'navigate' ],
		[ 'DELETE THIS PAGE.', 'navigate' ],
		[ 'UPLOAD IMAGE.', 'navigate' ],
		[ 'CAN YOU ADD MORE CONTENT TO THIS PAGE.', 'navigate' ],
		[ 'EDIT THIS.', 'navigate' ],
		[ 'OPEN EDITOR.', 'navigate' ],
		[ 'CLEAR SELECTION.', 'format' ],
		[ 'INSERT HORIZONTAL RULE.', 'insert_text' ],
		[ 'INSERT TABLE OF CONTENTS.', 'insert_text' ],
		[ 'HIDE TOC.', 'insert_text' ],
		[ 'ADD SIGNATURE.', 'insert_text' ],
		[ 'ADD TIMESTAMP.', 'insert_text' ],
		[ 'INSERT GALLERY.', 'insert_text' ],
		[ 'INSERT TABLE.', 'table' ],
		[ 'ADD CITATION NEEDED.', 'template' ]
	] )( 'accepts terminal punctuation on the argument-free command %s', async ( transcript, type ) => {
		const processor = makeProcessor();

		const result = await processor.process( transcript );

		expect( result.actions[ 0 ].type ).toBe( type );
		if ( type === 'save' ) {
			expect( result.actions[ 0 ].summary ).toBe( '' );
		}
	} );

	it.each( [
		[ 'BOLD', 'bold', "'''", "'''" ],
		[ 'ITALICIZE', 'italic', "''", "''" ],
		[ 'STRIKE THROUGH', 'strikethrough', '<s>', '</s>' ],
		[ 'STRIKE', 'strikethrough', '<s>', '</s>' ],
		[ 'CODE', 'code', '<code>', '</code>' ],
		[ 'UNDERLINE', 'underline', '<u>', '</u>' ],
		[ 'BLOCKQUOTE', 'blockquote', '\n<blockquote>\n', '\n</blockquote>\n' ],
		[ 'SUBSCRIPT', 'subscript', '<sub>', '</sub>' ],
		[ 'SUPERSCRIPT', 'superscript', '<sup>', '</sup>' ],
		[ 'SMALL', 'small', '<small>', '</small>' ],
		[ 'BIG', 'big', '<big>', '</big>' ]
	] )( 'canonicalizes the %s style without falling back to bold', async ( keyword, style, pre, post ) => {
		const processor = makeProcessor();

		const result = await processor.process( 'FORMAT AS ' + keyword + '.' );

		expect( result.actions[ 0 ] ).toMatchObject( {
			type: 'format', style, wrap: { pre, post }
		} );
	} );

	it.each( [ 'RENAME THIS PAGE', 'ReNaMe ThE PaGe', 'MOVE THIS PAGE', 'MOVE THE PAGE' ] )( 'uses the current page for %s', async ( prefix ) => {
		const processor = makeProcessor();

		const result = await processor.process( prefix + ' TO iPhone NASA' );

		expect( result.actions[ 0 ] ).toMatchObject( {
			type: 'navigate', target: 'Test_Page',
			url: '/wiki/Special:MovePage/Test_Page?wpNewTitle=iPhone+NASA'
		} );
	} );

	it.each( [ 'RENAME', 'MOVE PAGE FROM' ] )( 'preserves explicit source and destination in %s', async ( prefix ) => {
		const processor = makeProcessor();

		const result = await processor.process( prefix + ' iPhone NASA TO eBay FAQ?' );

		expect( result.actions[ 0 ] ).toMatchObject( {
			type: 'navigate', target: 'iPhone NASA',
			url: '/wiki/Special:MovePage/iPhone NASA?wpNewTitle=eBay+FAQ%3F'
		} );
	} );

	it( 'keeps the complete destination when a current-page rename contains another to', async () => {
		const processor = makeProcessor();

		const result = await processor.process( 'RENAME THIS PAGE TO Guide to NASA' );

		expect( result.actions[ 0 ].url )
			.toBe( '/wiki/Special:MovePage/Test_Page?wpNewTitle=Guide+to+NASA' );
	} );
} );

describe( 'custom shortcut parsing regressions', () => {
	let originalPost;

	beforeEach( () => {
		originalPost = global.__apiPost;
		global.__apiPost = jest.fn().mockResolvedValue( { intent: 'edit', actions: [] } );
	} );

	afterEach( () => {
		global.__apiPost = originalPost;
	} );

	it( 'normalizes shortcut keys but preserves the replacement summary', async () => {
		const processor = makeProcessor( {
			useLLM: true,
			customCommands: { '  QUICK   Save!  ': 'Save changes with summary Fix NASA: Café.' }
		} );

		const result = await processor.process( '  Quick   save.  ' );

		expect( result.actions[ 0 ] ).toMatchObject( {
			type: 'save', summary: 'Fix NASA: Café.'
		} );
		expect( global.__apiPost ).not.toHaveBeenCalled();
	} );

	it( 'preserves a local shortcut replacement URL and label', async () => {
		const processor = makeProcessor( {
			customCommands: { docs: 'Insert external link to https://Example.org/API?Key=AbC labeled NASA Docs!' }
		} );

		const result = await processor.process( 'DOCS.' );

		expect( result.actions[ 0 ].wikitext )
			.toBe( '[https://Example.org/API?Key=AbC NASA Docs!]' );
	} );

	it.each( [
		'Please explain NASA: Café?  Keep https://Example.org/API?Key=AbC',
		'Type NASA AND THEN save with summary Fix NASA.'
	] )( 'sends the unmatched expansion to the API verbatim: %s', async ( expansion ) => {
		const processor = makeProcessor( {
			useLLM: true, customCommands: { 'quick action': expansion }
		} );

		await processor.process( 'Quick Action.' );

		expect( global.__apiPost ).toHaveBeenCalledTimes( 1 );
		expect( global.__apiPost ).toHaveBeenCalledWith( expect.objectContaining( {
			command: expansion, mode: 'auto'
		} ) );
	} );

	it( 'does not send an unmatched expansion to the API when disabled', async () => {
		const processor = makeProcessor( {
			customCommands: { shortcut: 'Please improve NASA.' }
		} );

		const result = await processor.process( 'SHORTCUT.' );

		expect( result ).toMatchObject( { intent: 'unknown', actions: [] } );
		expect( global.__apiPost ).not.toHaveBeenCalled();
	} );

	it( 'does not expand a shortcut that is only a prefix of the transcript', async () => {
		const transcript = 'Quick save NASA?';
		const processor = makeProcessor( {
			useLLM: true, customCommands: { 'quick save': 'save' }
		} );

		await processor.process( transcript );

		expect( global.__apiPost ).toHaveBeenCalledWith( expect.objectContaining( {
			command: transcript, mode: 'auto'
		} ) );
	} );

	it( 'sends an unexpanded fallback transcript verbatim', async () => {
		const transcript = '  Please explain NASA: Café?  Keep Case.  ';
		const processor = makeProcessor( { useLLM: true } );

		await processor.process( transcript );

		expect( global.__apiPost ).toHaveBeenCalledWith( expect.objectContaining( {
			command: transcript, mode: 'auto'
		} ) );
	} );
} );

describe( 'dictation mode', () => {
	it( 'preserves dictation content and recognizes punctuated mixed-case controls', async () => {
		const processor = makeProcessor( { customCommands: { 'quick save': 'save' } } );
		await processor.process( 'START DICTATION.' );

		const dictated = await processor.process( 'Hello NASA COMMA Café.' );
		const shortcut = await processor.process( 'Quick save.' );
		const exit = await processor.process( 'StOp DiCtAtIoN!' );

		expect( dictated.actions[ 0 ].wikitext ).toBe( 'Hello NASA, Café.' );
		expect( shortcut.actions[ 0 ].wikitext ).toBe( 'Quick save.' );
		expect( exit.actions[ 0 ].type ).toBe( 'stop_dictation' );
		expect( processor.dictationMode ).toBe( false );
	} );

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

	it( 'parses quick jump navigation shortcuts', async () => {
		const processor = makeProcessor();

		let res = await processor.process( 'go to my watchlist' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].url ).toBe( '/wiki/Special:Watchlist' );

		res = await processor.process( 'view recent changes' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].url ).toBe( '/wiki/Special:RecentChanges' );

		res = await processor.process( 'open my contributions' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].url ).toBe( '/wiki/Special:Contributions' );

		res = await processor.process( 'go to special pages' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].url ).toBe( '/wiki/Special:SpecialPages' );

		res = await processor.process( 'open random page' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].url ).toBe( '/wiki/Special:Random' );

		res = await processor.process( 'go to talk page' );
		expect( res.actions[ 0 ].type ).toBe( 'navigate' );
		expect( res.actions[ 0 ].url ).toBe( '/wiki/Talk:Test_Page' );
	} );
} );

describe( 'LLM fallback', () => {
	const originalApiPost = global.__apiPost;

	afterEach( () => {
		global.__apiPost = originalApiPost;
	} );

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

describe( 'request cancellation regressions', () => {
	let originalPost;

	function deferred( abortable = true ) {
		let resolve, reject;
		const promise = new Promise( ( resolvePromise, rejectPromise ) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		} );
		if ( abortable ) {
			// Keep abort on the original promise, not on the promise returned by then().
			promise.abort = jest.fn();
		}
		return { promise, resolve, reject };
	}

	async function processPending( processor, mode ) {
		if ( mode === 'dictation' ) {
			await processor.process( 'start dictation' );
		}
		// Return a wrapper so this helper does not await the deferred API result.
		return { result: processor.process( 'please improve this paragraph' ) };
	}

	beforeEach( () => {
		originalPost = global.__apiPost;
	} );

	afterEach( () => {
		global.__apiPost = originalPost;
	} );

	describe.each( [ 'auto', 'dictation' ] )( '%s requests', ( mode ) => {
		describe.each( [ false, true ] )( 'abortable = %s', ( abortable ) => {
			it.each( [ 'success', 'rejection' ] )( 'returns null for a cancelled late %s', async ( outcome ) => {
				const old = deferred( abortable );
				const current = deferred();
				global.__apiPost = jest.fn().mockReturnValueOnce( old.promise )
					.mockReturnValueOnce( current.promise );
				const processor = makeProcessor( { useLLM: true } );
				const { result } = await processPending( processor, mode );
				expect( global.__apiPost ).toHaveBeenNthCalledWith(
					1, expect.objectContaining( { mode } )
				);
				expect( processor.requests.has( old.promise ) ).toBe( true );
				const generation = processor.generation;

				processor.cancel();
				expect( processor.generation ).toBe( generation + 1 );
				expect( processor.dictationMode ).toBe( false );
				expect( processor.requests.size ).toBe( 0 );
				if ( abortable ) {
					expect( old.promise.abort ).toHaveBeenCalledTimes( 1 );
				}
				const next = processor.process( 'please reorganize this paragraph' );
				if ( outcome === 'rejection' ) {
					old.reject( new Error( 'old service failure' ) );
				} else {
					old.resolve( { actions: [ { type: 'insert_text', wikitext: 'stale text' } ] } );
				}

				await expect( result ).resolves.toBeNull();
				expect( processor.requests ).toEqual( new Set( [ current.promise ] ) );
				expect( current.promise.abort ).not.toHaveBeenCalled();
				current.resolve( { actions: [ { type: 'insert_text', wikitext: 'current text' } ] } );
				await expect( next ).resolves.toMatchObject( {
					actions: [ { type: 'insert_text', wikitext: 'current text' } ]
				} );
				expect( processor.requests.size ).toBe( 0 );
			} );
		} );

		it.each( [ 'start_dictation', 'stop_dictation' ] )( 'late %s cannot mutate the new session', async ( type ) => {
			const request = deferred();
			global.__apiPost = () => request.promise;
			const processor = makeProcessor( { useLLM: true } );
			const { result } = await processPending( processor, mode );
			processor.cancel();
			// Choose the opposite state, so applying either stale control action is observable.
			if ( type === 'stop_dictation' ) {
				await processor.process( 'start dictation' );
			} else {
				await processor.process( 'help' );
			}
			const expectedMode = type === 'stop_dictation';
			expect( processor.dictationMode ).toBe( expectedMode );

			request.resolve( { actions: [ { type } ] } );

			await expect( result ).resolves.toBeNull();
			expect( processor.dictationMode ).toBe( expectedMode );
			expect( processor.requests.size ).toBe( 0 );
		} );

		it.each( [ 'success', 'rejection' ] )( 'releases completed active requests on %s without suppressing failures', async ( outcome ) => {
			const request = deferred();
			global.__apiPost = () => request.promise;
			const processor = makeProcessor( { useLLM: true } );
			const { result } = await processPending( processor, mode );
			expect( processor.requests ).toEqual( new Set( [ request.promise ] ) );
			const error = new Error( 'current service failure' );
			const response = {
				intent: 'edit', actions: [ { type: 'insert_text', wikitext: 'clean text' } ],
				audioFeedback: 'done', thinkingSteps: [ 'cleaned dictation' ]
			};

			if ( outcome === 'rejection' ) {
				request.reject( error );
				await expect( result ).rejects.toBe( error );
			} else {
				request.resolve( response );
				await expect( result ).resolves.toEqual( response );
			}

			expect( processor.requests.size ).toBe( 0 );
			processor.cancel();
			expect( request.promise.abort ).not.toHaveBeenCalled();
		} );
	} );

	it( 'aborts every original outstanding request even if one abort throws', async () => {
		const requests = [ deferred(), deferred(), deferred( false ) ];
		requests[ 0 ].promise.abort.mockImplementation( () => {
			throw new Error( 'transport already closed' );
		} );
		global.__apiPost = jest.fn()
			.mockReturnValueOnce( requests[ 0 ].promise )
			.mockReturnValueOnce( requests[ 1 ].promise )
			.mockReturnValueOnce( requests[ 2 ].promise );
		const processor = makeProcessor( { useLLM: true } );
		const first = processor.process( 'please improve this paragraph' );
		await processor.process( 'start dictation' );
		const second = processor.process( 'a dictated sentence' );
		const third = processor.process( 'another dictated sentence' );
		expect( processor.requests.size ).toBe( 3 );

		processor.cancel();

		expect( processor.requests.size ).toBe( 0 );
		expect( processor.dictationMode ).toBe( false );
		expect( requests[ 0 ].promise.abort ).toHaveBeenCalledTimes( 1 );
		expect( requests[ 1 ].promise.abort ).toHaveBeenCalledTimes( 1 );
		requests[ 0 ].resolve( { actions: [ { type: 'start_dictation' } ] } );
		requests[ 1 ].reject( new Error( 'aborted cleanup' ) );
		requests[ 2 ].resolve( { actions: [ { type: 'insert_text', wikitext: 'stale' } ] } );
		await expect( Promise.all( [ first, second, third ] ) )
			.resolves.toEqual( [ null, null, null ] );
		expect( processor.dictationMode ).toBe( false );
		processor.cancel();
		expect( requests[ 0 ].promise.abort ).toHaveBeenCalledTimes( 1 );
		expect( requests[ 1 ].promise.abort ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'invalidates state before abort synchronously rejects the pending request', async () => {
		const request = deferred();
		global.__apiPost = () => request.promise;
		const processor = makeProcessor( { useLLM: true } );
		const { result } = await processPending( processor, 'dictation' );
		const generation = processor.generation;
		let atAbort;
		request.promise.abort.mockImplementation( () => {
			atAbort = {
				generation: processor.generation,
				dictationMode: processor.dictationMode,
				pending: processor.requests.size
			};
			request.reject( new Error( 'aborted synchronously' ) );
		} );

		processor.cancel();

		expect( atAbort ).toEqual( {
			generation: generation + 1, dictationMode: false, pending: 0
		} );
		await expect( result ).resolves.toBeNull();
	} );

	it( 'releases only completed requests before cancelling those still pending', async () => {
		const completed = deferred();
		const pending = deferred();
		global.__apiPost = jest.fn().mockReturnValueOnce( completed.promise )
			.mockReturnValueOnce( pending.promise );
		const processor = makeProcessor( { useLLM: true } );
		const first = processor.process( 'please improve this paragraph' );
		const second = processor.process( 'please reorganize this paragraph' );

		completed.resolve( { actions: [] } );
		await first;

		expect( processor.requests ).toEqual( new Set( [ pending.promise ] ) );
		processor.cancel();
		expect( completed.promise.abort ).not.toHaveBeenCalled();
		expect( pending.promise.abort ).toHaveBeenCalledTimes( 1 );
		pending.resolve( { actions: [] } );
		await expect( second ).resolves.toBeNull();
	} );

	it.each( [ 'start_dictation', 'stop_dictation' ] )( 'applies current %s after an earlier cancellation', async ( type ) => {
		const request = deferred();
		global.__apiPost = () => request.promise;
		const processor = makeProcessor( { useLLM: true } );
		processor.cancel();
		if ( type === 'stop_dictation' ) {
			await processor.process( 'start dictation' );
		}
		const result = processor.process( 'please change dictation mode' );

		request.resolve( { actions: [ { type } ] } );

		await expect( result ).resolves.toMatchObject( { actions: [ { type } ] } );
		expect( processor.dictationMode ).toBe( type === 'start_dictation' );
		expect( processor.requests.size ).toBe( 0 );
	} );
} );
