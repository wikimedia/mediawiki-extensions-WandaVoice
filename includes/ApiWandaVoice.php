<?php

namespace MediaWiki\Extension\WandaVoice;

use ApiBase;
use ApiMain;
use MediaWiki\MediaWikiServices;
use MediaWiki\Request\DerivativeRequest;
use MediaWiki\SpecialPage\SpecialPage;
use MediaWiki\Title\Title;
use Wikimedia\ParamValidator\ParamValidator;

/**
 * API module that turns a transcribed voice command into a structured,
 * validated list of actions the client can execute (T410215).
 *
 * The heavy lifting of speech capture happens in the browser via the Web
 * Speech API; this module receives the final transcript and:
 *
 *  1. Asks Wanda's LLM (through an internal `wandachat` request with a strict
 *     intent-classification prompt) to decompose the utterance into discrete
 *     operations. This reuses the wiki's existing Wanda configuration and
 *     provider credentials rather than duplicating any LLM plumbing.
 *  2. Validates every proposed action against a whitelist of action types,
 *     resolves page titles with fuzzy matching, resolves section names to
 *     section indexes, and checks the requesting user's edit permissions.
 *  3. Translates formatting intents into wikitext ("make this bold" =>
 *     '''...''') and builds localised audio feedback sentences.
 *
 * The module never writes to the wiki itself: edits are performed client-side
 * through the normal editing interface (or Wanda's own two-phase `wandaedit`
 * module), so all existing permission and protection layers keep applying.
 */
class ApiWandaVoice extends ApiBase {

	/** Actions the LLM is allowed to propose. Anything else is discarded. */
	private const ACTION_TYPES = [
		'navigate', 'search', 'open_history', 'edit_section', 'insert_text',
		'format', 'heading', 'link', 'template', 'bullet', 'image',
		'save', 'preview', 'undo', 'cancel', 'dictate',
		'start_dictation', 'stop_dictation'
	];

	/** Maximum number of actions accepted from a single utterance. */
	private const MAX_ACTIONS = 8;

	/** Maximum accepted length for any string coming back from the LLM. */
	private const MAX_STRING_LENGTH = 2000;

	public function execute() {
		$params = $this->extractRequestParams();

		if ( !$this->getConfig()->get( 'WandaVoiceEnabled' ) ) {
			$this->dieWithError( 'wandavoice-api-error-disabled', 'wandavoice-disabled' );
		}

		$command = trim( (string)$params['command'] );
		if ( $command === '' ) {
			$this->dieWithError( 'wandavoice-api-error-empty', 'wandavoice-empty' );
		}

		$context = trim( (string)$params['context'] );
		$mode = $params['mode'];
		$showThinking = (bool)$params['showthinking'];
		$thinking = [];

		// Dictation mode: the transcript is content, not a command.
		if ( $mode === 'dictation' ) {
			$text = $command;
			if ( $this->getConfig()->get( 'WandaVoiceUseLLM' ) ) {
				$thinking[] = 'Cleaning up dictated text with the LLM.';
				$text = $this->cleanupDictation( $command, (string)$params['lang'], $thinking );
			}
			$this->buildDictationResult( $text, $thinking, $showThinking );
			return;
		}

		if ( !$this->getConfig()->get( 'WandaVoiceUseLLM' ) ) {
			$this->dieWithError( 'wandavoice-api-error-llm-disabled', 'wandavoice-llm-disabled' );
		}

		$thinking[] = 'Parsing command with LLM: "' . $command . '"';
		$intent = $this->parseWithLLM( $command, $context, $mode, (string)$params['lang'], $thinking );

		if ( !$intent || !isset( $intent['actions'] ) || !is_array( $intent['actions'] ) ) {
			$this->buildUnknownResult( $thinking, $showThinking );
			return;
		}

		// The LLM may decide the utterance was dictation after all.
		if ( ( $intent['mode'] ?? 'command' ) === 'dictation' && $mode === 'auto' ) {
			$text = $intent['text'] ?? $command;
			$this->buildDictationResult( (string)$text, $thinking, $showThinking );
			return;
		}

		$actions = $this->resolveActions( $intent['actions'], $context, $thinking );
		if ( !$actions ) {
			$this->buildUnknownResult( $thinking, $showThinking );
			return;
		}

		$feedback = [];
		foreach ( $actions as $action ) {
			if ( isset( $action['feedback'] ) && $action['feedback'] !== '' ) {
				$feedback[] = $action['feedback'];
			}
		}

		$result = $this->getResult();
		$result->addValue( null, 'success', true );
		$result->addValue( null, 'intent', $this->classifyIntent( $actions ) );
		$result->addValue( null, 'voiceProcessed', true );
		$result->addValue( null, 'actions', array_values( $actions ) );
		$result->addValue( null, 'audioFeedback', implode( ' ', $feedback ) );
		if ( $showThinking ) {
			$result->addValue( null, 'thinkingSteps', $thinking );
		}
	}

	/**
	 * Send the transcript to Wanda's LLM with an intent-classification prompt
	 * via an internal wandachat API request, and decode the JSON reply.
	 *
	 * @param string $command Transcribed voice command
	 * @param string $context Current page title, if any
	 * @param string $mode 'command' or 'auto'
	 * @param string $lang Language of the voice input, if known
	 * @param string[] &$thinking Reasoning trace
	 * @return array|null Decoded intent structure or null on failure
	 */
	private function parseWithLLM(
		string $command, string $context, string $mode, string $lang, array &$thinking
	): ?array {
		$request = new DerivativeRequest(
			$this->getRequest(),
			[
				'action' => 'wandachat',
				'format' => 'json',
				'message' => $command,
				'customprompt' => $this->buildIntentPrompt( $context, $mode, $lang ),
				'skipesquery' => true,
				'usepublicknowledge' => true,
				'temperature' => '0',
				'maxtokens' => 2000
			],
			true
		);

		try {
			$api = new ApiMain( $request );
			$api->execute();
			$data = $api->getResult()->getResultData( null, [ 'Strip' => 'all' ] );
		} catch ( \Exception $e ) {
			$thinking[] = 'LLM request failed: ' . $e->getMessage();
			$this->dieWithError( 'wandavoice-api-error-llm-unavailable', 'wandavoice-llm-unavailable' );
			return null;
		}

		$response = $data['response'] ?? ( $data['wandachat']['response'] ?? null );
		if ( !is_string( $response ) || $response === '' ) {
			$thinking[] = 'LLM returned an empty response.';
			return null;
		}

		$decoded = $this->decodeJsonReply( $response );
		$thinking[] = $decoded === null
			? 'Could not decode the LLM reply as JSON.'
			: 'Decoded intent: ' . ( $decoded['mode'] ?? 'command' ) . ', ' .
				count( $decoded['actions'] ?? [] ) . ' action(s).';

		return $decoded;
	}

	/**
	 * Fix punctuation and capitalisation of dictated text via the LLM,
	 * falling back to the raw transcript on any failure.
	 *
	 * @param string $transcript
	 * @param string $lang Language of the voice input, if known
	 * @param string[] &$thinking Reasoning trace
	 * @return string
	 */
	private function cleanupDictation( string $transcript, string $lang, array &$thinking ): string {
		$langLine = $lang !== '' ? " The text language is {$lang}." : '';
		$prompt = 'The user message is text dictated by voice for a wiki page.' . $langLine .
			' Fix punctuation, capitalisation and spoken punctuation words ("comma", "period", ' .
			'"new line") but never change the wording. Respond with ONLY the corrected text, ' .
			'no preamble and no quotation marks around it.';

		$request = new DerivativeRequest(
			$this->getRequest(),
			[
				'action' => 'wandachat',
				'format' => 'json',
				'message' => $transcript,
				'customprompt' => $prompt,
				'skipesquery' => true,
				'usepublicknowledge' => true,
				'temperature' => '0',
				'maxtokens' => 2000
			],
			true
		);

		try {
			$api = new ApiMain( $request );
			$api->execute();
			$data = $api->getResult()->getResultData( null, [ 'Strip' => 'all' ] );
			$response = $data['response'] ?? ( $data['wandachat']['response'] ?? null );
			if ( is_string( $response ) && trim( $response ) !== '' ) {
				return $this->cleanString( $response );
			}
		} catch ( \Exception $e ) {
			$thinking[] = 'Dictation cleanup failed, using the raw transcript.';
		}
		return $transcript;
	}

	/**
	 * Build the strict intent-classification prompt for the LLM.
	 *
	 * @param string $context Current page title
	 * @param string $mode Client mode hint
	 * @param string $lang Language of the voice input, if known
	 * @return string
	 */
	private function buildIntentPrompt( string $context, string $mode, string $lang ): string {
		$contextLine = $context !== ''
			? "The user is currently on the wiki page \"{$context}\"."
			: 'The current page is unknown.';
		if ( $lang !== '' ) {
			$contextLine .= " The utterance language is {$lang}.";
		}

		return <<<PROMPT
You are the intent parser of a voice-controlled MediaWiki interface. The user message is a
transcribed voice utterance. Decompose it into wiki operations.

{$contextLine} Client mode hint: {$mode}.

Respond with ONLY a JSON object (no prose, no code fences) with this shape:
{
  "mode": "command" or "dictation",
  "actions": [ ... ],
  "text": "only for dictation mode: the cleaned-up text to insert"
}

Use "dictation" mode when the utterance is content to be written rather than an instruction.
For dictation, fix punctuation and capitalisation in "text" but never change the wording.

Each action must be one of:
  {"type": "navigate", "target": "<page title>"}
  {"type": "search", "query": "<search terms>"}
  {"type": "open_history", "target": "<page title, optional>"}
  {"type": "edit_section", "page": "<page title, optional>", "section": "<section name or number>"}
  {"type": "insert_text", "text": "<sentence or paragraph to insert>"}
  {"type": "format", "style": "bold" or "italic", "text": "<target text, optional>"}
  {"type": "heading", "level": <2-6>, "text": "<heading text>"}
  {"type": "link", "target": "<page title>", "label": "<display text, optional>"}
  {"type": "template", "name": "<template name>"}
  {"type": "bullet", "text": "<list item text>"}
  {"type": "image", "file": "<file name>", "caption": "<caption, optional>"}
  {"type": "save", "summary": "<edit summary, optional>"}
  {"type": "preview"}
  {"type": "undo"}
  {"type": "cancel"}
  {"type": "start_dictation"}
  {"type": "stop_dictation"}

Rules:
- Preserve the order of operations in compound commands.
- "citation needed" means {"type": "template", "name": "citation needed"}.
- If the user corrects themselves ("...wait, undo that, instead..."), emit {"type": "undo"}
  followed by the corrected action, and drop the superseded one.
- Only use the action types listed above. If nothing fits, return {"mode": "command", "actions": []}.
PROMPT;
	}

	/**
	 * Decode an LLM reply that should contain JSON, tolerating code fences
	 * and surrounding prose.
	 *
	 * @param string $response
	 * @return array|null
	 */
	private function decodeJsonReply( string $response ): ?array {
		$text = trim( $response );

		if ( preg_match( '/```(?:json)?\s*\n?([\s\S]*?)\n?```/', $text, $m ) ) {
			$text = trim( $m[1] );
		}
		// Fall back to the outermost braces if the model added prose around the JSON.
		if ( $text === '' || $text[0] !== '{' ) {
			$start = strpos( $text, '{' );
			$end = strrpos( $text, '}' );
			if ( $start === false || $end === false || $end <= $start ) {
				return null;
			}
			$text = substr( $text, $start, $end - $start + 1 );
		}

		$decoded = json_decode( $text, true );
		return is_array( $decoded ) ? $decoded : null;
	}

	/**
	 * Validate, sanitise and resolve the raw actions proposed by the LLM.
	 *
	 * @param array $rawActions
	 * @param string $context Current page title
	 * @param string[] &$thinking Reasoning trace
	 * @return array[] Resolved actions
	 */
	private function resolveActions( array $rawActions, string $context, array &$thinking ): array {
		$resolved = [];

		foreach ( array_slice( $rawActions, 0, self::MAX_ACTIONS ) as $raw ) {
			if ( !is_array( $raw ) || !isset( $raw['type'] )
				|| !in_array( $raw['type'], self::ACTION_TYPES, true )
			) {
				$thinking[] = 'Discarded an action with an unknown type.';
				continue;
			}

			$action = $this->resolveAction( $raw, $context, $thinking );
			if ( $action ) {
				$resolved[] = $action;
			}
		}

		return $resolved;
	}

	/**
	 * Resolve a single whitelisted action.
	 *
	 * @param array $raw
	 * @param string $context
	 * @param string[] &$thinking
	 * @return array|null
	 */
	private function resolveAction( array $raw, string $context, array &$thinking ): ?array {
		$type = $raw['type'];

		switch ( $type ) {
			case 'navigate':
			case 'open_history':
				$target = $this->cleanString( $raw['target'] ?? $context );
				if ( $target === '' ) {
					return null;
				}
				$title = $this->resolvePage( $target, $thinking );
				if ( !$title ) {
					return [
						'type' => $type,
						'target' => $target,
						'status' => 'not_found',
						'feedback' => $this->msg( 'wandavoice-feedback-page-not-found', $target )->text()
					];
				}
				$query = $type === 'open_history' ? [ 'action' => 'history' ] : [];
				return [
					'type' => $type,
					'target' => $title->getPrefixedText(),
					'exists' => $title->exists(),
					'url' => $title->getLocalURL( $query ),
					'status' => 'ready',
					'feedback' => $this->msg(
						$type === 'navigate' ? 'wandavoice-feedback-navigating' : 'wandavoice-feedback-history',
						$title->getPrefixedText()
					)->text()
				];

			case 'search':
				$queryText = $this->cleanString( $raw['query'] ?? '' );
				if ( $queryText === '' ) {
					return null;
				}
				$special = SpecialPage::getTitleFor( 'Search' );
				return [
					'type' => 'search',
					'query' => $queryText,
					'url' => $special->getLocalURL( [ 'search' => $queryText ] ),
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-searching', $queryText )->text()
				];

			case 'edit_section':
				$pageName = $this->cleanString( $raw['page'] ?? '' ) ?: $context;
				if ( $pageName === '' ) {
					return null;
				}
				$title = $this->resolvePage( $pageName, $thinking );
				if ( !$title || !$title->exists() ) {
					return [
						'type' => 'edit_section',
						'target' => $pageName,
						'status' => 'not_found',
						'feedback' => $this->msg( 'wandavoice-feedback-page-not-found', $pageName )->text()
					];
				}
				if ( !$this->userCanEdit( $title ) ) {
					return $this->deniedAction( 'edit_section', $title->getPrefixedText() );
				}
				[ $sectionIndex, $sectionName ] = $this->resolveSection(
					$title, $this->cleanString( (string)( $raw['section'] ?? '' ) ), $thinking
				);
				return [
					'type' => 'edit_section',
					'target' => $title->getPrefixedText(),
					'section' => $sectionIndex,
					'sectionName' => $sectionName,
					'url' => $title->getLocalURL( [ 'action' => 'edit', 'section' => $sectionIndex ] ),
					'status' => 'ready',
					'feedback' => $this->msg(
						'wandavoice-feedback-editing', $sectionName, $title->getPrefixedText()
					)->text()
				];

			case 'insert_text':
			case 'dictate':
				$text = $this->cleanString( $raw['text'] ?? '' );
				if ( $text === '' ) {
					return null;
				}
				return [
					'type' => 'insert_text',
					'wikitext' => $text,
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-inserted' )->text()
				];

			case 'format':
				$style = ( $raw['style'] ?? '' ) === 'italic' ? 'italic' : 'bold';
				$marker = $style === 'italic' ? "''" : "'''";
				$text = $this->cleanString( $raw['text'] ?? '' );
				$action = [
					'type' => 'format',
					'style' => $style,
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-formatted', $style )->text()
				];
				if ( $text !== '' ) {
					$action['wikitext'] = $marker . $text . $marker;
				} else {
					// No explicit text: the client wraps the current selection.
					$action['wrap'] = [ 'pre' => $marker, 'post' => $marker ];
				}
				return $action;

			case 'heading':
				$text = $this->cleanString( $raw['text'] ?? '' );
				if ( $text === '' ) {
					return null;
				}
				$level = max( 2, min( 6, (int)( $raw['level'] ?? 2 ) ) );
				$markup = str_repeat( '=', $level );
				return [
					'type' => 'heading',
					'wikitext' => "\n" . $markup . ' ' . $text . ' ' . $markup . "\n",
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-inserted' )->text()
				];

			case 'link':
				$target = $this->cleanString( $raw['target'] ?? '' );
				if ( $target === '' ) {
					return null;
				}
				$label = $this->cleanString( $raw['label'] ?? '' );
				$title = $this->resolvePage( $target, $thinking );
				$targetText = $title ? $title->getPrefixedText() : $target;
				return [
					'type' => 'link',
					'wikitext' => $label !== '' && $label !== $targetText
						? '[[' . $targetText . '|' . $label . ']]'
						: '[[' . $targetText . ']]',
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-inserted' )->text()
				];

			case 'template':
				$name = $this->cleanString( $raw['name'] ?? '' );
				if ( $name === '' ) {
					return null;
				}
				return [
					'type' => 'template',
					'wikitext' => '{{' . $name . '}}',
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-inserted' )->text()
				];

			case 'bullet':
				$text = $this->cleanString( $raw['text'] ?? '' );
				if ( $text === '' ) {
					return null;
				}
				return [
					'type' => 'bullet',
					'wikitext' => "\n* " . $text,
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-inserted' )->text()
				];

			case 'image':
				$file = $this->cleanString( $raw['file'] ?? '' );
				if ( $file === '' ) {
					return null;
				}
				$file = preg_replace( '/^(?:file|image|commons)\s*:\s*/i', '', $file );
				$caption = $this->cleanString( $raw['caption'] ?? '' );
				$wikitext = '[[File:' . $file . '|thumb' . ( $caption !== '' ? '|' . $caption : '' ) . ']]';
				return [
					'type' => 'image',
					'wikitext' => $wikitext,
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-inserted' )->text()
				];

			case 'save':
				return [
					'type' => 'save',
					'summary' => $this->cleanString( $raw['summary'] ?? '' ),
					'status' => 'ready',
					'feedback' => $this->msg( 'wandavoice-feedback-saved' )->text()
				];

			case 'preview':
			case 'undo':
			case 'cancel':
			case 'start_dictation':
			case 'stop_dictation':
				$feedbackKeys = [
					'preview' => 'wandavoice-feedback-previewing',
					'undo' => 'wandavoice-feedback-undone',
					'cancel' => 'wandavoice-feedback-cancelled',
					'start_dictation' => 'wandavoice-feedback-dictation-on',
					'stop_dictation' => 'wandavoice-feedback-dictation-off'
				];
				return [
					'type' => $type,
					'status' => 'ready',
					'feedback' => $this->msg( $feedbackKeys[$type] )->text()
				];
		}

		return null;
	}

	/**
	 * Resolve a spoken page name to a Title, using exact match first and the
	 * search engine's fuzzy completion as fallback.
	 *
	 * @param string $text
	 * @param string[] &$thinking
	 * @return Title|null
	 */
	private function resolvePage( string $text, array &$thinking ): ?Title {
		$title = Title::newFromText( $text );
		if ( $title && $title->exists() ) {
			$thinking[] = "Resolved page \"{$text}\" by exact match.";
			return $title;
		}

		try {
			$searchEngine = MediaWikiServices::getInstance()->getSearchEngineFactory()->create();
			$searchEngine->setLimitOffset( 1 );
			if ( method_exists( $searchEngine, 'completionSearchFuzzy' ) ) {
				$suggestionSet = $searchEngine->completionSearchFuzzy( $text );
			} elseif ( method_exists( $searchEngine, 'completionSearch' ) ) {
				$suggestionSet = $searchEngine->completionSearch( $text );
			} else {
				$suggestionSet = null;
			}
			if ( $suggestionSet ) {
				$suggestions = $suggestionSet->getSuggestions();
				if ( $suggestions ) {
					$match = $suggestions[0]->getSuggestedTitle();
					if ( $match ) {
						$thinking[] = "Resolved page \"{$text}\" to \"{$match->getPrefixedText()}\" by fuzzy matching.";
						return Title::newFromLinkTarget( $match );
					}
				}
			}
		} catch ( \Throwable $e ) {
			$thinking[] = 'Fuzzy page lookup failed: ' . $e->getMessage();
		}

		if ( $title && $title->canExist() ) {
			$thinking[] = "Page \"{$text}\" does not exist; treating as a new page title.";
			return $title;
		}
		return null;
	}

	/**
	 * Resolve a spoken section reference to a MediaWiki section index.
	 *
	 * @param Title $title
	 * @param string $section Spoken section name or number
	 * @param string[] &$thinking
	 * @return array{0:int,1:string} Section index and display name
	 */
	private function resolveSection( Title $title, string $section, array &$thinking ): array {
		$introName = $this->msg( 'wandavoice-section-introduction' )->text();
		if ( $section === '' || preg_match( '/^(0|intro|introduction|lead|top)$/i', $section ) ) {
			return [ 0, $introName ];
		}
		if ( ctype_digit( $section ) ) {
			return [ (int)$section, $this->msg( 'wandavoice-section-number', $section )->text() ];
		}

		$page = MediaWikiServices::getInstance()->getWikiPageFactory()->newFromTitle( $title );
		$content = $page->getContent();
		$text = $content instanceof \TextContent ? $content->getText() : '';

		$index = 0;
		$wanted = mb_strtolower( trim( $section ) );
		if ( preg_match_all( '/^(={1,6})\s*(.+?)\s*\1\s*$/m', $text, $matches, PREG_SET_ORDER ) ) {
			foreach ( $matches as $match ) {
				$index++;
				$headingText = mb_strtolower( trim( strip_tags( $match[2] ) ) );
				if ( $headingText === $wanted
					|| str_contains( $headingText, $wanted )
					|| str_contains( $wanted, $headingText )
				) {
					$thinking[] = "Resolved section \"{$section}\" to index {$index}.";
					return [ $index, trim( $match[2] ) ];
				}
			}
		}

		$thinking[] = "Section \"{$section}\" not found; defaulting to the introduction.";
		return [ 0, $introName ];
	}

	/**
	 * @param Title $title
	 * @return bool
	 */
	private function userCanEdit( Title $title ): bool {
		$pm = MediaWikiServices::getInstance()->getPermissionManager();
		return $pm->userCan( 'edit', $this->getUser(), $title );
	}

	/**
	 * @param string $type
	 * @param string $target
	 * @return array
	 */
	private function deniedAction( string $type, string $target ): array {
		return [
			'type' => $type,
			'target' => $target,
			'status' => 'denied',
			'feedback' => $this->msg( 'wandavoice-feedback-no-permission', $target )->text()
		];
	}

	/**
	 * Trim and cap a string coming from the LLM or the client.
	 *
	 * @param mixed $value
	 * @return string
	 */
	private function cleanString( $value ): string {
		if ( !is_string( $value ) ) {
			return '';
		}
		return mb_substr( trim( $value ), 0, self::MAX_STRING_LENGTH );
	}

	/**
	 * Derive a compact intent label such as "navigation_and_edit".
	 *
	 * @param array[] $actions
	 * @return string
	 */
	private function classifyIntent( array $actions ): string {
		$groups = [];
		foreach ( $actions as $action ) {
			switch ( $action['type'] ) {
				case 'navigate':
				case 'open_history':
					$groups['navigation'] = true;
					break;
				case 'search':
					$groups['search'] = true;
					break;
				case 'edit_section':
				case 'insert_text':
				case 'format':
				case 'heading':
				case 'link':
				case 'template':
				case 'bullet':
				case 'image':
					$groups['edit'] = true;
					break;
				default:
					$groups['control'] = true;
			}
		}
		return implode( '_and_', array_keys( $groups ) ) ?: 'unknown';
	}

	/**
	 * Add a dictation result: cleaned text to insert at the cursor.
	 *
	 * @param string $text
	 * @param string[] $thinking
	 * @param bool $showThinking
	 */
	private function buildDictationResult( string $text, array $thinking, bool $showThinking ) {
		$result = $this->getResult();
		$result->addValue( null, 'success', true );
		$result->addValue( null, 'intent', 'dictation' );
		$result->addValue( null, 'voiceProcessed', true );
		$result->addValue( null, 'actions', [ [
			'type' => 'insert_text',
			'wikitext' => $text,
			'status' => 'ready',
			'feedback' => $this->msg( 'wandavoice-feedback-inserted' )->text()
		] ] );
		$result->addValue( null, 'audioFeedback', $this->msg( 'wandavoice-feedback-inserted' )->text() );
		if ( $showThinking ) {
			$result->addValue( null, 'thinkingSteps', $thinking );
		}
	}

	/**
	 * Add an "understood nothing" result.
	 *
	 * @param string[] $thinking
	 * @param bool $showThinking
	 */
	private function buildUnknownResult( array $thinking, bool $showThinking ) {
		$result = $this->getResult();
		$result->addValue( null, 'success', false );
		$result->addValue( null, 'intent', 'unknown' );
		$result->addValue( null, 'voiceProcessed', true );
		$result->addValue( null, 'actions', [] );
		$result->addValue( null, 'audioFeedback', $this->msg( 'wandavoice-error-unknown' )->text() );
		if ( $showThinking ) {
			$result->addValue( null, 'thinkingSteps', $thinking );
		}
	}

	/** @inheritDoc */
	public function mustBePosted() {
		return true;
	}

	/** @inheritDoc */
	public function getAllowedParams() {
		return [
			'command' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_REQUIRED => true
			],
			'context' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_DEFAULT => ''
			],
			'mode' => [
				ParamValidator::PARAM_TYPE => [ 'auto', 'command', 'dictation' ],
				ParamValidator::PARAM_DEFAULT => 'auto'
			],
			'lang' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_DEFAULT => ''
			],
			'showthinking' => [
				ParamValidator::PARAM_TYPE => 'boolean',
				ParamValidator::PARAM_DEFAULT => false
			]
		];
	}

	/** @inheritDoc */
	protected function getExamplesMessages() {
		return [
			'action=wandavoice&command=navigate to Main Page&format=json'
				=> 'apihelp-wandavoice-example-navigate',
			'action=wandavoice&command=edit the introduction section and add a sentence' .
				'&context=Albert Einstein&showthinking=true&format=json'
				=> 'apihelp-wandavoice-example-edit'
		];
	}
}
