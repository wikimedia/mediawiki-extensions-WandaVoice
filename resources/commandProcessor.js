/**
 * Turns a transcribed utterance into a list of executable actions.
 *
 * A small local grammar handles simple, single-intent commands instantly and
 * offline (navigation, search, save, undo, formatting, ...). Anything the
 * grammar does not recognise is sent to the `wandavoice` API module, which
 * uses Wanda's LLM for intent recognition and performs server-side
 * validation (fuzzy page matching, section resolution, permission checks).
 */

/**
 * Normalise shortcut keys only, never command arguments.
 *
 * @param {string} text
 * @return {string}
 */
function normalize( text ) {
	return text.toLowerCase().replace( /\s+/g, ' ' ).trim().replace( /[.,!?;:]+$/, '' ).trim();
}

/**
 * Map spoken punctuation words to characters for offline dictation.
 *
 * @param {string} text
 * @return {string}
 */
function spokenPunctuation( text ) {
	return text
		.replace( /\b(full stop|period)\b/gi, '.' )
		.replace( /\bcomma\b/gi, ',' )
		.replace( /\bquestion mark\b/gi, '?' )
		.replace( /\bexclamation (?:mark|point)\b/gi, '!' )
		.replace( /\bcolon\b/gi, ':' )
		.replace( /\bsemicolon\b/gi, ';' )
		.replace( /\b(?:em dash)\b/gi, '—' )
		.replace( /\b(?:dash|hyphen)\b/gi, '-' )
		.replace( /\b(?:open quote|left quote)\b/gi, '"' )
		.replace( /\b(?:close quote|right quote)\b/gi, '"' )
		.replace( /\b(?:open parenthesis|left parenthesis|open paren)\b/gi, '(' )
		.replace( /\b(?:close parenthesis|right parenthesis|close paren)\b/gi, ')' )
		.replace( /\bslash\b/gi, '/' )
		.replace( /\bbackslash\b/gi, '\\' )
		.replace( /\bat sign\b/gi, '@' )
		.replace( /\b(?:hashtag|hash mark)\b/gi, '#' )
		.replace( /\bnew line\b/gi, '\n' )
		.replace( /\bnew paragraph\b/gi, '\n\n' )
		.replace( /\s+([.,?!:;])/g, '$1' )
		.replace( /"\s+/g, '"' )
		.replace( /\s+"/g, '"' )
		.replace( /\(\s+/g, '(' )
		.replace( /\s+\)/g, ')' )
		.replace( /[ \t]*\n[ \t]*/g, '\n' );
}

class CommandProcessor {
	/**
	 * @param {Object} config wgWandaVoice configuration object
	 */
	constructor( config ) {
		this.config = config;
		this.api = new mw.Api();
		this.dictationMode = false;
		this.generation = 0;
		this.requests = new Set();
	}

	/** Invalidate pending results before attempting transport cancellation. */
	cancel() {
		this.generation++;
		this.dictationMode = false;
		const requests = Array.from( this.requests );
		this.requests.clear();
		requests.forEach( ( request ) => {
			if ( typeof request.abort === 'function' ) {
				try {
					request.abort();
				} catch ( e ) {
					// Generation checks still discard results if abort fails.
				}
			}
		} );
	}

	/**
	 * Process a final transcript into { actions, audioFeedback, thinkingSteps, intent }.
	 *
	 * @param {string} transcript
	 * @return {Promise<Object>}
	 */
	async process( transcript ) {
		let expanded = transcript;

		// Custom shortcut phrases from $wgWandaVoiceCustomCommands.
		const custom = this.config.customCommands || {};
		for ( const phrase in custom ) {
			if ( normalize( transcript ) === normalize( phrase ) ) {
				expanded = String( custom[ phrase ] );
				break;
			}
		}
		// Retain case and punctuation in captures; only normalise grammar whitespace.
		const command = expanded.replace( /\s+/g, ' ' ).trim();

		// While dictating, everything except "stop dictation" is content.
		if ( this.dictationMode ) {
			const dictationLocal = this.parseLocally( command );
			if ( dictationLocal && dictationLocal.actions[ 0 ].type === 'stop_dictation' ) {
				this.dictationMode = false;
				return dictationLocal;
			}
			return this.dictate( transcript );
		}

		const local = this.parseLocally( command );
		if ( local ) {
			if ( local.actions[ 0 ].type === 'start_dictation' ) {
				this.dictationMode = true;
			}
			return local;
		}

		if ( !this.config.useLLM ) {
			return {
				intent: 'unknown',
				actions: [],
				audioFeedback: mw.message( 'wandavoice-error-unknown' ).text(),
				thinkingSteps: []
			};
		}

		return this.callApi( expanded, 'auto' );
	}

	/**
	 * Local grammar for instant, offline handling of simple commands.
	 * Returns null when the utterance needs the LLM.
	 *
	 * @param {string} command Whitespace-normalised command with original case and punctuation
	 * @return {Object|null}
	 */
	parseLocally( command ) {
		// Compound commands go to the LLM.
		if ( /\b(?:and then|then|and)\b/i.test( command ) && !/^(?:search|navigate|go|open|visit|jump)/i.test( command ) ) {
			return null;
		}

		// Only argument-free commands may discard transcript-ending punctuation.
		const control = command.replace( /[.,!?;:]+$/, '' ).trim();
		let m;

		m = command.match( /^(?:open|show|view|go to)(?: my)? watchlist$/ );
		if ( m ) {
			return this.simple( 'navigate', {
				target: 'Special:Watchlist',
				url: mw.util.getUrl( 'Special:Watchlist' )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:Watchlist' ).text() );
		}

		m = command.match( /^(?:open|show|view|go to) recent changes$/ );
		if ( m ) {
			return this.simple( 'navigate', {
				target: 'Special:RecentChanges',
				url: mw.util.getUrl( 'Special:RecentChanges' )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:RecentChanges' ).text() );
		}

		m = command.match( /^(?:open|show|view|go to)(?: my)? contributions$/ );
		if ( m ) {
			return this.simple( 'navigate', {
				target: 'Special:Contributions',
				url: mw.util.getUrl( 'Special:Contributions' )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:Contributions' ).text() );
		}

		m = command.match( /^(?:open|show|view|go to) special pages$/ );
		if ( m ) {
			return this.simple( 'navigate', {
				target: 'Special:SpecialPages',
				url: mw.util.getUrl( 'Special:SpecialPages' )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:SpecialPages' ).text() );
		}

		m = command.match( /^(?:open|show|view|go to)(?: a)? random page$/ );
		if ( m ) {
			return this.simple( 'navigate', {
				target: 'Special:Random',
				url: mw.util.getUrl( 'Special:Random' )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:Random' ).text() );
		}

		m = command.match( /^(?:open|show|view|go to)(?: the)? (?:talk|discussion)(?: page)?$/ );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' ) || '';
			let talkPage = page;
			if ( page ) {
				const parts = page.split( ':' );
				if ( parts.length > 1 && /^talk$/i.test( parts[ 0 ] ) ) {
					talkPage = parts.slice( 1 ).join( ':' );
				} else if ( parts.length > 1 && /_talk$/i.test( parts[ 0 ] ) ) {
					talkPage = page;
				} else {
					talkPage = 'Talk:' + page;
				}
			} else {
				talkPage = 'Talk:Main_Page';
			}
			return this.simple( 'navigate', {
				target: talkPage,
				url: mw.util.getUrl( talkPage )
			}, mw.message( 'wandavoice-feedback-navigating', talkPage ).text() );
		}

		m = command.match( /^(?:navigate|go|take me|open page|visit|jump)(?: to)? (?:the )?(.+)$/i ) ||
			command.match( /^open (?:the )?page (.+)$/i );
		if ( m ) {
			return this.simple( 'navigate', {
				target: m[ 1 ],
				url: mw.util.getUrl( m[ 1 ] )
			}, mw.message( 'wandavoice-feedback-navigating', m[ 1 ] ).text() );
		}

		m = command.match( /^(?:search|look|find|lookup)(?: for| up)? (.+)$/i );
		if ( m ) {
			return this.simple( 'search', {
				query: m[ 1 ],
				url: mw.util.getUrl( 'Special:Search', { search: m[ 1 ] } )
			}, mw.message( 'wandavoice-feedback-searching', m[ 1 ] ).text() );
		}

		m = control.match( /^(?:open|show|view) (?:the )?(?:page )?history$/i );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			return this.simple( 'open_history', {
				target: page,
				url: mw.util.getUrl( page, { action: 'history' } )
			}, mw.message( 'wandavoice-feedback-history', page ).text() );
		}

		m = command.match( /^(?:move|rename)(?: page)? (?!(?:this|the) page to )(?:from )?(.+?) to (.+)$/i ) ||
			command.match( /^(?:change|update) (?:the )?(?:title|name) (?:of (?:the )?(?:page )?(?:to )?)?(.+?) to (.+)$/i );
		if ( m ) {
			const fromPage = m[ 1 ];
			const toPage = m[ 2 ];
			return this.simple( 'navigate', {
				target: fromPage,
				url: mw.util.getUrl( 'Special:MovePage/' + fromPage, { wpNewTitle: toPage } )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:MovePage/' + fromPage ).text() );
		}

		m = command.match( /^(?:change|update) (?:the )?(?:title|name) (?:of (?:this|the) page )?to (.+)$/i ) ||
			command.match( /^(?:move|rename) (?:this|the) page to (.+)$/i );
		if ( m ) {
			const currentPage = mw.config.get( 'wgPageName' );
			const newTitle = m[ 1 ];
			return this.simple( 'navigate', {
				target: currentPage,
				url: mw.util.getUrl( 'Special:MovePage/' + currentPage, { wpNewTitle: newTitle } )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:MovePage/' + currentPage ).text() );
		}

		m = command.match( /^(?:create|make|start)(?: a)? (?:new )?page (?:called |named )?(.+)$/i );
		if ( m ) {
			const targetPage = m[ 1 ];
			return this.simple( 'navigate', {
				target: targetPage,
				url: mw.util.getUrl( targetPage, { action: 'edit' } )
			}, mw.message( 'wandavoice-feedback-navigating', targetPage ).text() );
		}

		m = command.match( /^(?:create|make|start)(?: a)? subpage (?:called |named )?(.+)$/i );
		if ( m ) {
			const parentPage = mw.config.get( 'wgPageName' );
			const subPage = parentPage + '/' + m[ 1 ];
			return this.simple( 'navigate', {
				target: subPage,
				url: mw.util.getUrl( subPage, { action: 'edit' } )
			}, mw.message( 'wandavoice-feedback-navigating', subPage ).text() );
		}

		m = control.match( /^(?:protect|lock) (?:this|the) page$/i );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			return this.simple( 'navigate', {
				target: page,
				url: mw.util.getUrl( page, { action: 'protect' } )
			}, mw.message( 'wandavoice-feedback-navigating', page ).text() );
		}

		m = control.match( /^(?:delete|remove) (?:this|the) page$/i );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			return this.simple( 'navigate', {
				target: page,
				url: mw.util.getUrl( page, { action: 'delete' } )
			}, mw.message( 'wandavoice-feedback-navigating', page ).text() );
		}

		m = control.match( /^upload (?:file|image|media)$/i );
		if ( m ) {
			return this.simple( 'navigate', {
				target: 'Special:Upload',
				url: mw.util.getUrl( 'Special:Upload' )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:Upload' ).text() );
		}

		m = control.match( /^(?:can you )?(?:edit|add|insert|append|write)(?: (?:more |some )?(?:content|text))? (?:to|in|on)? ?(?:this|the)? ?page$/i ) ||
			control.match( /^(?:edit|open editor for) (?:this|the page|this page|current page)$/i ) ||
			control.match( /^(?:start editing|open editor)$/i );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			return this.simple( 'navigate', {
				target: page,
				url: mw.util.getUrl( page, { action: 'edit' } )
			}, mw.message( 'wandavoice-feedback-editpage', page ).text() );
		}

		m = command.match( /^edit section (\d+)$/i ) ||
			command.match( /^edit section (?:called |named )?(.+)$/i );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			const sec = m[ 1 ];
			return this.simple( 'edit_section', {
				target: page,
				section: /^\d+$/.test( sec ) ? parseInt( sec, 10 ) : sec,
				url: mw.util.getUrl( page, { action: 'edit', section: sec } )
			}, mw.message( 'wandavoice-feedback-editing', sec, page ).text() );
		}

		m = control.match( /^(?:make (?:this|that|it|selection|text) |format (?:as )?|(?:make|insert|add|bold|italic|italicize|code|strikethrough|strike|underline|blockquote|subscript|superscript|small|big) )?(bold|italic|italicize|code|strikethrough|strike through|strike|underline|blockquote|subscript|superscript|small|big)(?: (?:this|that|it|selection|text))?$/i );
		if ( m ) {
			let style = m[ 1 ].toLowerCase();
			if ( style === 'italicize' ) {
				style = 'italic';
			} else if ( style === 'strike through' || style === 'strike' ) {
				style = 'strikethrough';
			}
			const wrapMap = {
				bold: { pre: "'''", post: "'''" },
				italic: { pre: "''", post: "''" },
				code: { pre: '<code>', post: '</code>' },
				strikethrough: { pre: '<s>', post: '</s>' },
				underline: { pre: '<u>', post: '</u>' },
				blockquote: { pre: '\n<blockquote>\n', post: '\n</blockquote>\n' },
				subscript: { pre: '<sub>', post: '</sub>' },
				superscript: { pre: '<sup>', post: '</sup>' },
				small: { pre: '<small>', post: '</small>' },
				big: { pre: '<big>', post: '</big>' }
			};
			return this.simple( 'format', {
				style: style,
				wrap: wrapMap[ style ] || wrapMap.bold
			}, mw.message( 'wandavoice-feedback-formatted', style ).text() );
		}

		m = control.match( /^(?:clear|delete|remove) (?:the )?(?:selection|text)$/i );
		if ( m ) {
			return this.simple( 'format', {
				style: 'clear',
				clear: true
			}, mw.message( 'wandavoice-feedback-formatted', 'clear' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?link (?:to|for) (.+?) (?:labeled|as|with text) (.+)$/i );
		if ( m ) {
			return this.simple( 'link', {
				wikitext: '[[' + m[ 1 ] + '|' + m[ 2 ] + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:an? )?external link (?:to )?(https?:\/\/\S+)(?: (?:labeled|with text|as) (.+))?$/i );
		if ( m ) {
			const url = m[ 1 ];
			const label = m[ 2 ] ? ' ' + m[ 2 ] : '';
			return this.simple( 'link', {
				wikitext: '[' + url + label + ']'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?redirect (?:to|for) (.+)$/i ) ||
			command.match( /^redirect (?:this page )?to (.+)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '#REDIRECT [[' + m[ 1 ] + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = control.match( /^(?:create|insert|add) (?:a )?(?:horizontal rule|horizontal line|line break)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n----\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = control.match( /^(?:create|insert|add) (?:a )?(?:table of contents|toc)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n__TOC__\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = control.match( /^hide (?:table of contents|toc)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n__NOTOC__\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = control.match( /^(?:create|insert|add) (?:my )?(?:signature|sign)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '~~~~'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = control.match( /^(?:create|insert|add) (?:a )?timestamp$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '~~~~~'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?definition (?:for )?(.+?) (?:definition|is|means) (.+)$/i ) ||
			command.match( /^(?:create|insert|add) (?:a )?term (.+?) definition (.+)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n; ' + m[ 1 ] + ' : ' + m[ 2 ]
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = control.match( /^(?:create|insert|add) (?:a )?gallery$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n<gallery>\nFile:Example.jpg|Caption 1\nFile:Example.png|Caption 2\n</gallery>\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:preformatted text|pre block) (.+)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n<pre>\n' + m[ 1 ] + '\n</pre>\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?math (?:formula |equation )?(.+)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '<math>' + m[ 1 ] + '</math>'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?code block (.+)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n<syntaxhighlight lang="text">\n' + m[ 1 ] + '\n</syntaxhighlight>\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?link (?:to|for) (.+)$/i ) ||
			command.match( /^link to (.+)$/i );
		if ( m ) {
			return this.simple( 'link', {
				wikitext: '[[' + m[ 1 ] + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?(?:heading|section)(?: level (\d))? (?:called |named )?(.+)$/i ) ||
			command.match( /^add level (\d) heading (.+)$/i );
		if ( m ) {
			const levelNum = m[ 1 ] || '2';
			const nameText = m[ 2 ];
			const level = Math.max( 1, Math.min( 6, parseInt( levelNum, 10 ) ) );
			const markup = '='.repeat( level );
			return this.simple( 'heading', {
				wikitext: '\n' + markup + ' ' + nameText + ' ' + markup + '\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?bullet ?(?:point)? (.+)$/i ) ||
			command.match( /^bullet point (.+)$/i );
		if ( m ) {
			return this.simple( 'bullet', {
				wikitext: '\n* ' + m[ 1 ]
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?numbered (?:point|item|list) (.+)$/i ) ||
			command.match( /^numbered (?:point|item) (.+)$/i );
		if ( m ) {
			return this.simple( 'number', {
				wikitext: '\n# ' + m[ 1 ]
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = control.match( /^(?:create|insert|add) (?:a )?(?:standard )?table$/i );
		if ( m ) {
			return this.simple( 'table', {
				wikitext: '\n{| class="wikitable"\n! Header 1 !! Header 2\n|-\n| Item 1 || Item 2\n|}\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?(?:reference|footnote) (.+)$/i );
		if ( m ) {
			return this.simple( 'reference', {
				wikitext: '<ref>' + m[ 1 ] + '</ref>'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?category (.+)$/i );
		if ( m ) {
			return this.simple( 'category', {
				wikitext: '\n[[Category:' + m[ 1 ] + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add|embed) (?:an? )?image (.+)$/i );
		if ( m ) {
			return this.simple( 'image', {
				wikitext: '[[File:' + m[ 1 ] + '|thumb|' + m[ 1 ] + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = control.match( /^(?:add|insert) citation needed$/i );
		if ( m ) {
			return this.simple( 'template', {
				wikitext: '{{citation needed}}'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:insert|add|use) (?:the )?(?:template|(.+) template) ?(.*)$/i );
		if ( m && ( m[ 1 ] || m[ 2 ] ) ) {
			const name = ( m[ 1 ] || m[ 2 ] ).trim();
			return this.simple( 'template', {
				wikitext: '{{' + name + '}}'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:save|publish)(?: (?:changes|page|the page))?(?: with summary (.+))?$/i ) ||
			control.match( /^(?:save|publish)(?: (?:changes|page|the page))?$/i );
		if ( m ) {
			return this.simple( 'save', {
				summary: m[ 1 ] || ''
			}, mw.message( 'wandavoice-feedback-saved' ).text() );
		}

		if ( /^(?:show )?preview(?: page)?$/i.test( control ) ) {
			return this.simple( 'preview', {}, mw.message( 'wandavoice-feedback-previewing' ).text() );
		}

		if ( /^undo(?: that| last(?: change| edit)?)?$/i.test( control ) ) {
			return this.simple( 'undo', {}, mw.message( 'wandavoice-feedback-undone' ).text() );
		}

		if ( /^(?:cancel|never ?mind)$/i.test( control ) ) {
			return this.simple( 'cancel', {}, mw.message( 'wandavoice-feedback-cancelled' ).text() );
		}

		if ( /^(?:stop|turn off)(?: listening| voice)?$/i.test( control ) ) {
			return this.simple( 'stop_listening', {}, mw.message( 'wandavoice-feedback-listening-off' ).text() );
		}

		if ( /^(?:start |begin )?dictat(?:e|ion)(?: mode)?$/i.test( control ) ) {
			return this.simple( 'start_dictation', {}, mw.message( 'wandavoice-feedback-dictation-on' ).text() );
		}

		if ( /^(?:stop|end|exit) dictat(?:e|ion)(?: mode)?$/i.test( control ) ) {
			return this.simple( 'stop_dictation', {}, mw.message( 'wandavoice-feedback-dictation-off' ).text() );
		}

		if ( /^(?:help|show help)$/i.test( control ) ) {
			return this.simple( 'help', {}, '' );
		}

		m = command.match( /^(?:type|write|dictate|insert text) (.+)$/i );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: spokenPunctuation( m[ 1 ] )
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		return null;
	}

	/**
	 * Handle a dictation-mode utterance: clean it up (via LLM when
	 * available, offline punctuation mapping otherwise) and insert it.
	 *
	 * @param {string} transcript
	 * @return {Promise<Object>|Object}
	 */
	dictate( transcript ) {
		if ( this.config.useLLM ) {
			return this.callApi( transcript, 'dictation' );
		}
		return this.simple( 'insert_text', {
			wikitext: spokenPunctuation( transcript )
		}, mw.message( 'wandavoice-feedback-inserted' ).text() );
	}

	/**
	 * Ask the wandavoice API module to parse the command with the LLM.
	 *
	 * @param {string} command
	 * @param {string} mode
	 * @return {Promise<Object|null>} Null when the request was cancelled
	 */
	async callApi( command, mode ) {
		const generation = this.generation;
		// Keep the original abortable mw.Api promise, not a chained promise.
		const request = this.api.post( {
			action: 'wandavoice',
			format: 'json',
			command: command,
			context: mw.config.get( 'wgPageName' ),
			mode: mode,
			lang: this.config.language,
			showthinking: this.config.showThinking ? 1 : 0
		} );
		this.requests.add( request );
		let data;
		try {
			data = await request;
		} catch ( e ) {
			if ( generation !== this.generation ) {
				return null;
			}
			throw e;
		} finally {
			this.requests.delete( request );
		}
		if ( generation !== this.generation ) {
			return null;
		}

		const actions = data.actions || [];
		actions.forEach( ( action ) => {
			if ( action.type === 'start_dictation' ) {
				this.dictationMode = true;
			} else if ( action.type === 'stop_dictation' ) {
				this.dictationMode = false;
			}
		} );

		return {
			intent: data.intent || 'unknown',
			actions: actions,
			audioFeedback: data.audioFeedback || '',
			thinkingSteps: data.thinkingSteps || []
		};
	}

	/**
	 * Build a single-action local result.
	 *
	 * @param {string} type
	 * @param {Object} props
	 * @param {string} feedback
	 * @return {Object}
	 */
	simple( type, props, feedback ) {
		const action = Object.assign( { type: type, status: 'ready', feedback: feedback }, props );
		return {
			intent: type,
			actions: [ action ],
			audioFeedback: feedback,
			thinkingSteps: [ 'Matched local command grammar: ' + type ]
		};
	}

	/**
	 * Capitalise the first letter (page titles, headings).
	 *
	 * @param {string} text
	 * @return {string}
	 */
	titleCase( text ) {
		return text.charAt( 0 ).toUpperCase() + text.slice( 1 );
	}
}

module.exports = CommandProcessor;
