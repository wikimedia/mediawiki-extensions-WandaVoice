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
		const veSurface = this.getVeSurface();

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
				if ( veSurface ) {
					this.insertWikitextVE( veSurface, action );
				} else {
					this.insertWikitext( action );
				}
				break;
			case 'format':
				if ( veSurface ) {
					this.applyFormatVE( veSurface, action );
				} else {
					this.applyFormat( action );
				}
				break;
			case 'save':
				if ( veSurface ) {
					this.saveVE( action );
				} else {
					this.save( action );
				}
				break;
			case 'preview':
				if ( veSurface ) {
					this.previewVE( action );
				} else {
					this.preview( action );
				}
				break;
			case 'undo':
				if ( veSurface ) {
					this.undoVE( veSurface, action );
				} else {
					this.undo( action );
				}
				break;
			default:
				// cancel / start_dictation / stop_dictation / unknown types
				// are handled by the caller; just announce them.
				this.handlers.onFeedback( action.feedback || '' );
		}
	}

	/**
	 * @return {Object|null} The VisualEditor surface object if active, or null
	 */
	getVeSurface() {
		if ( window.ve && window.ve.init && window.ve.init.target ) {
			const target = window.ve.init.target;
			if ( typeof target.getSurface === 'function' ) {
				const surface = target.getSurface();
				if ( surface && surface.getModel() ) {
					return surface;
				}
			}
		}
		return null;
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
	 * Insert text or wikitext inside VisualEditor.
	 *
	 * @param {Object} surface VE surface
	 * @param {Object} action
	 */
	insertWikitextVE( surface, action ) {
		if ( !action.wikitext ) {
			return;
		}
		const fragment = surface.getModel().getFragment();
		let text = action.wikitext;

		if ( action.type === 'insert_text' ) {
			const range = typeof fragment.getRange === 'function' ? fragment.getRange() : null;
			if ( range && typeof range.isCollapsed === 'function' && range.isCollapsed() ) {
				let before = '';
				if ( typeof fragment.getTextBefore === 'function' ) {
					before = fragment.getTextBefore();
				} else if ( surface.getModel().getDocument &&
					typeof surface.getModel().getDocument().getText === 'function'
				) {
					const doc = surface.getModel().getDocument();
					if ( window.ve && window.ve.Range ) {
						const startPos = Math.max( 0, range.start - 10 );
						before = doc.getText( new window.ve.Range( startPos, range.start ) );
					}
				}
				if ( before && !/\s$/.test( before ) && !/^[\s.,;:!?]/.test( text ) ) {
					text = ' ' + text;
				}
			}
		}

		fragment.insertContent( text );
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
	 * Apply formatting (bold, italic, clear, etc.) inside VisualEditor.
	 *
	 * @param {Object} surface VE surface
	 * @param {Object} action
	 */
	applyFormatVE( surface, action ) {
		const fragment = surface.getModel().getFragment();
		if ( action.clear ) {
			if ( typeof fragment.clearAnnotations === 'function' ) {
				fragment.clearAnnotations();
			} else if ( typeof fragment.insertContent === 'function' ) {
				fragment.insertContent( '' );
			}
		} else if ( action.style === 'bold' || action.style === 'italic' ) {
			if ( typeof fragment.annotateContent === 'function' ) {
				fragment.annotateContent( 'set', action.style );
			}
		} else if ( action.wikitext ) {
			fragment.insertContent( action.wikitext );
		} else if ( action.wrap ) {
			const selText = typeof fragment.getText === 'function' ? fragment.getText() : '';
			const text = action.wrap.pre + selText + action.wrap.post;
			fragment.insertContent( text );
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
	 * Save inside VisualEditor.
	 *
	 * @param {Object} action
	 */
	saveVE( action ) {
		const target = window.ve.init.target;
		if ( typeof target.executeCommand === 'function' ) {
			target.executeCommand( 'showSave' );
		} else if ( typeof target.save === 'function' ) {
			target.save();
		}
		this.handlers.onFeedback( action.feedback || '' );
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
	 * Preview (show changes) inside VisualEditor.
	 *
	 * @param {Object} action
	 */
	previewVE( action ) {
		const target = window.ve.init.target;
		if ( typeof target.executeCommand === 'function' ) {
			target.executeCommand( 'showChanges' );
		}
		this.handlers.onFeedback( action.feedback || '' );
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

	/**
	 * Undo inside VisualEditor.
	 *
	 * @param {Object} surface VE surface
	 * @param {Object} action
	 */
	undoVE( surface, action ) {
		const model = surface.getModel();
		if ( typeof model.undo === 'function' ) {
			model.undo();
		}
		this.handlers.onFeedback( action.feedback || '' );
	}
}

window.CommandExecutor = CommandExecutor;
module.exports = CommandExecutor;
