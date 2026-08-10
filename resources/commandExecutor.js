/**
 * Executes the structured actions produced by the command processor.
 *
 * Editing actions use jQuery.textSelection so they work with both the plain
 * wikitext textarea and CodeMirror. Compound commands that navigate away
 * (e.g. "navigate to X, edit section 2 and add a sentence") persist their
 * remaining actions in sessionStorage and resume after the page loads.
 */

const STORAGE_KEY = 'wandavoice-pending-actions';

class CommandExecutor {
	/**
	 * @param {Object} config wgWandaVoice configuration object
	 * @param {Object} handlers { onFeedback, onError }
	 */
	constructor( config, handlers ) {
		this.config = config;
		this.handlers = handlers;
		// Stack of textarea snapshots for voice-initiated undo.
		this.undoStack = [];
	}

	/**
	 * Execute a list of actions sequentially.
	 *
	 * @param {Object[]} actions
	 * @return {Promise<void>}
	 */
	async executeActions( actions ) {
		for ( let i = 0; i < actions.length; i++ ) {
			const action = actions[ i ];

			if ( action.status === 'not_found' || action.status === 'denied' ) {
				this.handlers.onFeedback( action.feedback || '' );
				continue;
			}

			// Navigation unloads the page: stash the rest of the plan first.
			if ( action.type === 'navigate' || action.type === 'search' ||
				action.type === 'open_history' || action.type === 'edit_section'
			) {
				const remaining = actions.slice( i + 1 );
				if ( remaining.length ) {
					try {
						sessionStorage.setItem( STORAGE_KEY, JSON.stringify( remaining ) );
					} catch ( e ) {
						// Session storage unavailable; remaining actions are dropped.
					}
				}
				this.handlers.onFeedback( action.feedback || '' );
				window.location.href = action.url;
				return;
			}

			this.executeLocal( action );
		}
	}

	/**
	 * Resume actions stashed before a navigation, if any.
	 *
	 * @return {Object[]} The pending actions (already removed from storage)
	 */
	takePendingActions() {
		let pending = [];
		try {
			const raw = sessionStorage.getItem( STORAGE_KEY );
			if ( raw ) {
				sessionStorage.removeItem( STORAGE_KEY );
				pending = JSON.parse( raw ) || [];
			}
		} catch ( e ) {
			pending = [];
		}
		return Array.isArray( pending ) ? pending : [];
	}

	/**
	 * Execute a non-navigating action on the current page.
	 *
	 * @param {Object} action
	 */
	executeLocal( action ) {
		switch ( action.type ) {
			case 'insert_text':
			case 'heading':
			case 'link':
			case 'template':
			case 'bullet':
			case 'number':
			case 'table':
			case 'image':
			case 'reference':
			case 'category':
				this.insertWikitext( action );
				break;
			case 'format':
				this.applyFormat( action );
				break;
			case 'save':
				this.save( action );
				break;
			case 'preview':
				this.preview( action );
				break;
			case 'undo':
				this.undo( action );
				break;
			default:
				// cancel / start_dictation / stop_dictation / unknown types
				// are handled by the caller; just announce them.
				this.handlers.onFeedback( action.feedback || '' );
		}
	}

	/**
	 * @return {jQuery|null} The wikitext editor textarea, if present
	 */
	getEditor() {
		// eslint-disable-next-line no-jquery/no-global-selector
		const $textarea = $( '#wpTextbox1' );
		if ( !$textarea.length ) {
			this.handlers.onError( mw.message( 'wandavoice-error-noeditor' ).text() );
			return null;
		}
		return $textarea;
	}

	/**
	 * Snapshot the editor contents for voice-initiated undo.
	 *
	 * @param {jQuery} $textarea
	 */
	snapshot( $textarea ) {
		this.undoStack.push( $textarea.textSelection( 'getContents' ) );
		if ( this.undoStack.length > 50 ) {
			this.undoStack.shift();
		}
	}

	/**
	 * Insert generated wikitext at the cursor position.
	 *
	 * @param {Object} action
	 */
	insertWikitext( action ) {
		const $textarea = this.getEditor();
		if ( !$textarea || !action.wikitext ) {
			return;
		}
		this.snapshot( $textarea );
		const selected = $textarea.textSelection( 'getSelection' );
		// Insert a leading space between flowing text and dictated sentences.
		let text = action.wikitext;
		if ( action.type === 'insert_text' && !selected ) {
			const caret = $textarea.textSelection( 'getCaretPosition' );
			const before = $textarea.textSelection( 'getContents' ).slice( 0, caret );
			if ( before && !/\s$/.test( before ) && !/^[\s.,;:!?]/.test( text ) ) {
				text = ' ' + text;
			}
		}
		$textarea.textSelection( 'replaceSelection', text );
		$textarea.textSelection( 'scrollToCaretPosition' );
		this.handlers.onFeedback( action.feedback || '' );
	}

	/**
	 * Apply bold/italic to the current selection, or insert pre-built markup.
	 *
	 * @param {Object} action
	 */
	applyFormat( action ) {
		const $textarea = this.getEditor();
		if ( !$textarea ) {
			return;
		}
		this.snapshot( $textarea );
		if ( action.clear ) {
			$textarea.textSelection( 'replaceSelection', '' );
		} else if ( action.wikitext ) {
			$textarea.textSelection( 'replaceSelection', action.wikitext );
		} else if ( action.wrap ) {
			$textarea.textSelection( 'encapsulateSelection', {
				pre: action.wrap.pre,
				post: action.wrap.post
			} );
		}
		this.handlers.onFeedback( action.feedback || '' );
	}

	/**
	 * @param {Object} action
	 */
	save( action ) {
		// eslint-disable-next-line no-jquery/no-global-selector
		const $save = $( '#wpSave' );
		if ( !$save.length ) {
			this.handlers.onError( mw.message( 'wandavoice-error-noeditor' ).text() );
			return;
		}
		if ( action.summary ) {
			// eslint-disable-next-line no-jquery/no-global-selector
			$( '#wpSummary' ).val( action.summary );
		}
		this.handlers.onFeedback( action.feedback || '' );
		$save.trigger( 'click' );
	}

	/**
	 * @param {Object} action
	 */
	preview( action ) {
		// eslint-disable-next-line no-jquery/no-global-selector
		const $preview = $( '#wpPreview' );
		if ( !$preview.length ) {
			this.handlers.onError( mw.message( 'wandavoice-error-noeditor' ).text() );
			return;
		}
		this.handlers.onFeedback( action.feedback || '' );
		$preview.trigger( 'click' );
	}

	/**
	 * Restore the editor to the state before the last voice edit.
	 *
	 * @param {Object} action
	 */
	undo( action ) {
		const $textarea = this.getEditor();
		if ( !$textarea ) {
			return;
		}
		if ( !this.undoStack.length ) {
			this.handlers.onFeedback( mw.message( 'wandavoice-feedback-nothing-to-undo' ).text() );
			return;
		}
		$textarea.textSelection( 'setContents', this.undoStack.pop() );
		this.handlers.onFeedback( action.feedback || '' );
	}
}

module.exports = CommandExecutor;
