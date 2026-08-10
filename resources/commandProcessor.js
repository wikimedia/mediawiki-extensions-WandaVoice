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
 * @param {string} text
 * @return {string}
 */
function normalize( text ) {
	return text.toLowerCase().replace( /[.,!?;:]+$/g, '' ).replace( /\s+/g, ' ' ).trim();
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
	}

	/**
	 * Process a final transcript into { actions, audioFeedback, thinkingSteps, intent }.
	 *
	 * @param {string} transcript
	 * @return {Promise<Object>}
	 */
	async process( transcript ) {
		let command = normalize( transcript );

		// Custom shortcut phrases from $wgWandaVoiceCustomCommands.
		const custom = this.config.customCommands || {};
		for ( const phrase in custom ) {
			if ( command === normalize( phrase ) ) {
				command = normalize( String( custom[ phrase ] ) );
				break;
			}
		}

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

		return this.callApi( transcript, 'auto' );
	}

	/**
	 * Local grammar for instant, offline handling of simple commands.
	 * Returns null when the utterance needs the LLM.
	 *
	 * @param {string} command Normalised command
	 * @return {Object|null}
	 */
	parseLocally( command ) {
		// Compound commands go to the LLM.
		if ( /\b(?:and then|then|and)\b/.test( command ) && !/^(?:search|navigate|go|open|visit|jump)/.test( command ) ) {
			return null;
		}

		let m;

		m = command.match( /^(?:navigate|go|take me|open page|visit|jump)(?: to)? (?:the )?(.+)$/ ) ||
			command.match( /^open (?:the )?page (.+)$/ );
		if ( m ) {
			return this.simple( 'navigate', {
				target: m[ 1 ],
				url: mw.util.getUrl( m[ 1 ] )
			}, mw.message( 'wandavoice-feedback-navigating', m[ 1 ] ).text() );
		}

		m = command.match( /^(?:search|look|find|lookup)(?: for| up)? (.+)$/ );
		if ( m ) {
			return this.simple( 'search', {
				query: m[ 1 ],
				url: mw.util.getUrl( 'Special:Search', { search: m[ 1 ] } )
			}, mw.message( 'wandavoice-feedback-searching', m[ 1 ] ).text() );
		}

		m = command.match( /^(?:open|show|view) (?:the )?(?:page )?history$/ );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			return this.simple( 'open_history', {
				target: page,
				url: mw.util.getUrl( page, { action: 'history' } )
			}, mw.message( 'wandavoice-feedback-history', page ).text() );
		}

		m = command.match( /^(?:move|rename)(?: page)? (?:from )?(.+?) to (.+)$/ ) ||
			command.match( /^(?:change|update) (?:the )?(?:title|name) (?:of (?:the )?(?:page )?(?:to )?)?(.+?) to (.+)$/ );
		if ( m ) {
			const fromPage = m[ 1 ];
			const toPage = m[ 2 ];
			return this.simple( 'navigate', {
				target: fromPage,
				url: mw.util.getUrl( 'Special:MovePage/' + fromPage, { wpNewTitle: toPage } )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:MovePage/' + fromPage ).text() );
		}

		m = command.match( /^(?:change|update) (?:the )?(?:title|name) (?:of (?:this|the) page )?to (.+)$/ ) ||
			command.match( /^(?:move|rename) (?:this|the) page to (.+)$/ );
		if ( m ) {
			const currentPage = mw.config.get( 'wgPageName' );
			const newTitle = m[ 1 ];
			return this.simple( 'navigate', {
				target: currentPage,
				url: mw.util.getUrl( 'Special:MovePage/' + currentPage, { wpNewTitle: newTitle } )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:MovePage/' + currentPage ).text() );
		}

		m = command.match( /^(?:create|make|start)(?: a)? (?:new )?page (?:called |named )?(.+)$/ );
		if ( m ) {
			const targetPage = this.titleCase( m[ 1 ] );
			return this.simple( 'navigate', {
				target: targetPage,
				url: mw.util.getUrl( targetPage, { action: 'edit' } )
			}, mw.message( 'wandavoice-feedback-navigating', targetPage ).text() );
		}

		m = command.match( /^(?:create|make|start)(?: a)? subpage (?:called |named )?(.+)$/ );
		if ( m ) {
			const parentPage = mw.config.get( 'wgPageName' );
			const subPage = parentPage + '/' + this.titleCase( m[ 1 ] );
			return this.simple( 'navigate', {
				target: subPage,
				url: mw.util.getUrl( subPage, { action: 'edit' } )
			}, mw.message( 'wandavoice-feedback-navigating', subPage ).text() );
		}

		m = command.match( /^(?:protect|lock) (?:this|the) page$/ );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			return this.simple( 'navigate', {
				target: page,
				url: mw.util.getUrl( page, { action: 'protect' } )
			}, mw.message( 'wandavoice-feedback-navigating', page ).text() );
		}

		m = command.match( /^(?:delete|remove) (?:this|the) page$/ );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			return this.simple( 'navigate', {
				target: page,
				url: mw.util.getUrl( page, { action: 'delete' } )
			}, mw.message( 'wandavoice-feedback-navigating', page ).text() );
		}

		m = command.match( /^upload (?:file|image|media)$/ );
		if ( m ) {
			return this.simple( 'navigate', {
				target: 'Special:Upload',
				url: mw.util.getUrl( 'Special:Upload' )
			}, mw.message( 'wandavoice-feedback-navigating', 'Special:Upload' ).text() );
		}

		m = command.match( /^(?:can you )?(?:edit|add|insert|append|write)(?: (?:more |some )?(?:content|text))? (?:to|in|on)? ?(?:this|the)? ?page$/ ) ||
			command.match( /^(?:edit|open editor for) (?:this|the page|this page|current page)$/ ) ||
			command.match( /^(?:start editing|open editor)$/ );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			return this.simple( 'navigate', {
				target: page,
				url: mw.util.getUrl( page, { action: 'edit' } )
			}, mw.message( 'wandavoice-feedback-editpage', page ).text() );
		}

		m = command.match( /^edit section (\d+)$/ ) ||
			command.match( /^edit section (?:called |named )?(.+)$/ );
		if ( m ) {
			const page = mw.config.get( 'wgPageName' );
			const sec = m[ 1 ];
			return this.simple( 'edit_section', {
				target: page,
				section: /^\d+$/.test( sec ) ? parseInt( sec, 10 ) : sec,
				url: mw.util.getUrl( page, { action: 'edit', section: sec } )
			}, mw.message( 'wandavoice-feedback-editing', sec, page ).text() );
		}

		m = command.match( /^(?:make (?:this|that|it|selection|text) |format (?:as )?|(?:make|insert|add|bold|italic|italicize|code|strikethrough|strike|underline|blockquote|subscript|superscript|small|big) )?(bold|italic|italicize|code|strikethrough|strike through|strike|underline|blockquote|subscript|superscript|small|big)(?: (?:this|that|it|selection|text))?$/ );
		if ( m ) {
			let style = m[ 1 ];
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

		m = command.match( /^(?:clear|delete|remove) (?:the )?(?:selection|text)$/ );
		if ( m ) {
			return this.simple( 'format', {
				style: 'clear',
				clear: true
			}, mw.message( 'wandavoice-feedback-formatted', 'clear' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?link (?:to|for) (.+?) (?:labeled|as|with text) (.+)$/ );
		if ( m ) {
			return this.simple( 'link', {
				wikitext: '[[' + this.titleCase( m[ 1 ] ) + '|' + m[ 2 ] + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:an? )?external link (?:to )?(https?:\/\/\S+)(?: (?:labeled|with text|as) (.+))?$/ );
		if ( m ) {
			const url = m[ 1 ];
			const label = m[ 2 ] ? ' ' + m[ 2 ] : '';
			return this.simple( 'link', {
				wikitext: '[' + url + label + ']'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?redirect (?:to|for) (.+)$/ ) ||
			command.match( /^redirect (?:this page )?to (.+)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '#REDIRECT [[' + this.titleCase( m[ 1 ] ) + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?(?:horizontal rule|horizontal line|line break)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n----\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?(?:table of contents|toc)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n__TOC__\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^hide (?:table of contents|toc)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n__NOTOC__\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:my )?(?:signature|sign)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '~~~~'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?timestamp$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '~~~~~'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?definition (?:for )?(.+?) (?:definition|is|means) (.+)$/ ) ||
			command.match( /^(?:create|insert|add) (?:a )?term (.+?) definition (.+)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n; ' + m[ 1 ] + ' : ' + m[ 2 ]
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?gallery$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n<gallery>\nFile:Example.jpg|Caption 1\nFile:Example.png|Caption 2\n</gallery>\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:preformatted text|pre block) (.+)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n<pre>\n' + m[ 1 ] + '\n</pre>\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?math (?:formula |equation )?(.+)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '<math>' + m[ 1 ] + '</math>'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?code block (.+)$/ );
		if ( m ) {
			return this.simple( 'insert_text', {
				wikitext: '\n<syntaxhighlight lang="text">\n' + m[ 1 ] + '\n</syntaxhighlight>\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?link (?:to|for) (.+)$/ ) ||
			command.match( /^link to (.+)$/ );
		if ( m ) {
			return this.simple( 'link', {
				wikitext: '[[' + this.titleCase( m[ 1 ] ) + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?(?:heading|section)(?: level (\d))? (?:called |named )?(.+)$/ ) ||
			command.match( /^add level (\d) heading (.+)$/ );
		if ( m ) {
			const levelNum = m[ 1 ] || '2';
			const nameText = m[ 2 ];
			const level = Math.max( 1, Math.min( 6, parseInt( levelNum, 10 ) ) );
			const markup = '='.repeat( level );
			return this.simple( 'heading', {
				wikitext: '\n' + markup + ' ' + this.titleCase( nameText ) + ' ' + markup + '\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?bullet ?(?:point)? (.+)$/ ) ||
			command.match( /^bullet point (.+)$/ );
		if ( m ) {
			return this.simple( 'bullet', {
				wikitext: '\n* ' + m[ 1 ]
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?numbered (?:point|item|list) (.+)$/ ) ||
			command.match( /^numbered (?:point|item) (.+)$/ );
		if ( m ) {
			return this.simple( 'number', {
				wikitext: '\n# ' + m[ 1 ]
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?(?:standard )?table$/ );
		if ( m ) {
			return this.simple( 'table', {
				wikitext: '\n{| class="wikitable"\n! Header 1 !! Header 2\n|-\n| Item 1 || Item 2\n|}\n'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?(?:reference|footnote) (.+)$/ );
		if ( m ) {
			return this.simple( 'reference', {
				wikitext: '<ref>' + m[ 1 ] + '</ref>'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add) (?:a )?category (.+)$/ );
		if ( m ) {
			return this.simple( 'category', {
				wikitext: '\n[[Category:' + this.titleCase( m[ 1 ] ) + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:create|insert|add|embed) (?:an? )?image (.+)$/ );
		if ( m ) {
			return this.simple( 'image', {
				wikitext: '[[File:' + this.titleCase( m[ 1 ] ) + '|thumb|' + m[ 1 ] + ']]'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:add|insert) citation needed$/ );
		if ( m ) {
			return this.simple( 'template', {
				wikitext: '{{citation needed}}'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:insert|add|use) (?:the )?(?:template|(.+) template) ?(.*)$/ );
		if ( m && ( m[ 1 ] || m[ 2 ] ) ) {
			const name = ( m[ 1 ] || m[ 2 ] ).trim();
			return this.simple( 'template', {
				wikitext: '{{' + name + '}}'
			}, mw.message( 'wandavoice-feedback-inserted' ).text() );
		}

		m = command.match( /^(?:save|publish)(?: (?:changes|page|the page))?(?: with summary (.+))?$/ );
		if ( m ) {
			return this.simple( 'save', {
				summary: m[ 1 ] || ''
			}, mw.message( 'wandavoice-feedback-saved' ).text() );
		}

		if ( /^(?:show )?preview(?: page)?$/.test( command ) ) {
			return this.simple( 'preview', {}, mw.message( 'wandavoice-feedback-previewing' ).text() );
		}

		if ( /^undo(?: that| last(?: change| edit)?)?$/.test( command ) ) {
			return this.simple( 'undo', {}, mw.message( 'wandavoice-feedback-undone' ).text() );
		}

		if ( /^(?:cancel|never ?mind)$/.test( command ) ) {
			return this.simple( 'cancel', {}, mw.message( 'wandavoice-feedback-cancelled' ).text() );
		}

		if ( /^(?:stop|turn off)(?: listening| voice)?$/.test( command ) ) {
			return this.simple( 'stop_listening', {}, mw.message( 'wandavoice-feedback-listening-off' ).text() );
		}

		if ( /^(?:start |begin )?dictat(?:e|ion)(?: mode)?$/.test( command ) ) {
			return this.simple( 'start_dictation', {}, mw.message( 'wandavoice-feedback-dictation-on' ).text() );
		}

		if ( /^(?:stop|end|exit) dictat(?:e|ion)(?: mode)?$/.test( command ) ) {
			return this.simple( 'stop_dictation', {}, mw.message( 'wandavoice-feedback-dictation-off' ).text() );
		}

		if ( /^(?:help|show help)$/.test( command ) ) {
			return this.simple( 'help', {}, '' );
		}

		m = command.match( /^(?:type|write|dictate|insert text) (.+)$/ );
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
	 * @return {Promise<Object>}
	 */
	async callApi( command, mode ) {
		const data = await this.api.post( {
			action: 'wandavoice',
			format: 'json',
			command: command,
			context: mw.config.get( 'wgPageName' ),
			mode: mode,
			lang: this.config.language,
			showthinking: this.config.showThinking ? 1 : 0
		} );

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
