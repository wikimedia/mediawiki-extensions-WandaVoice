<?php

namespace MediaWiki\Extension\WandaVoice\Tests\Unit;

use MediaWiki\Extension\WandaVoice\ApiWandaVoice;
use MediaWikiUnitTestCase;
use ReflectionClass;

/**
 * @group WandaVoice
 * @covers \MediaWiki\Extension\WandaVoice\ApiWandaVoice
 */
class ApiWandaVoiceTest extends MediaWikiUnitTestCase {

	/**
	 * Invoke a private method on an ApiWandaVoice instance created without
	 * running the constructor (the tested helpers are pure).
	 *
	 * @param string $name
	 * @param array $args
	 * @return mixed
	 */
	private function invokePrivate( string $name, array $args ) {
		$class = new ReflectionClass( ApiWandaVoice::class );
		$api = $class->newInstanceWithoutConstructor();
		$method = $class->getMethod( $name );
		$method->setAccessible( true );
		return $method->invokeArgs( $api, $args );
	}

	public static function provideDecodeJsonReply() {
		return [
			'plain JSON' => [
				'{"mode":"command","actions":[]}',
				[ 'mode' => 'command', 'actions' => [] ]
			],
			'fenced JSON' => [
				"```json\n{\"mode\":\"dictation\",\"actions\":[],\"text\":\"hi\"}\n```",
				[ 'mode' => 'dictation', 'actions' => [], 'text' => 'hi' ]
			],
			'fence without language tag' => [
				"```\n{\"mode\":\"command\",\"actions\":[]}\n```",
				[ 'mode' => 'command', 'actions' => [] ]
			],
			'JSON wrapped in prose' => [
				'Sure! Here is the intent: {"mode":"command","actions":[{"type":"undo"}]} Hope that helps.',
				[ 'mode' => 'command', 'actions' => [ [ 'type' => 'undo' ] ] ]
			],
			'no JSON at all' => [ 'I could not parse that command.', null ],
			'empty string' => [ '', null ],
			'scalar JSON is rejected' => [ '"just a string"', null ],
		];
	}

	/**
	 * @dataProvider provideDecodeJsonReply
	 * @param string $response
	 * @param array|null $expected
	 */
	public function testDecodeJsonReply( string $response, $expected ) {
		$this->assertSame( $expected, $this->invokePrivate( 'decodeJsonReply', [ $response ] ) );
	}

	public static function provideCleanString() {
		return [
			'non-string input' => [ null, '' ],
			'integer input' => [ 42, '' ],
			'array input' => [ [ 'x' ], '' ],
			'trimmed' => [ "  hello world \n", 'hello world' ],
		];
	}

	/**
	 * @dataProvider provideCleanString
	 * @param mixed $value
	 * @param string $expected
	 */
	public function testCleanString( $value, string $expected ) {
		$this->assertSame( $expected, $this->invokePrivate( 'cleanString', [ $value ] ) );
	}

	public function testCleanStringCapsLength() {
		$long = str_repeat( 'a', 5000 );
		$this->assertSame( 2000, mb_strlen( $this->invokePrivate( 'cleanString', [ $long ] ) ) );
	}

	public static function provideClassifyIntent() {
		return [
			'empty' => [ [], 'unknown' ],
			'navigation only' => [
				[ [ 'type' => 'navigate' ] ],
				'navigation'
			],
			'history counts as navigation' => [
				[ [ 'type' => 'open_history' ] ],
				'navigation'
			],
			'navigation and edit' => [
				[ [ 'type' => 'navigate' ], [ 'type' => 'edit_section' ], [ 'type' => 'insert_text' ] ],
				'navigation_and_edit'
			],
			'search and control' => [
				[ [ 'type' => 'search' ], [ 'type' => 'save' ] ],
				'search_and_control'
			],
			'formatting is an edit' => [
				[ [ 'type' => 'format' ], [ 'type' => 'template' ], [ 'type' => 'bullet' ] ],
				'edit'
			],
		];
	}

	/**
	 * @dataProvider provideClassifyIntent
	 * @param array $actions
	 * @param string $expected
	 */
	public function testClassifyIntent( array $actions, string $expected ) {
		$this->assertSame( $expected, $this->invokePrivate( 'classifyIntent', [ $actions ] ) );
	}

	public function testIntentPromptContainsContextAndWhitelist() {
		$prompt = $this->invokePrivate( 'buildIntentPrompt', [ 'Albert Einstein', 'auto', 'en-US' ] );
		$this->assertStringContainsString( 'Albert Einstein', $prompt );
		$this->assertStringContainsString( 'en-US', $prompt );
		// Every whitelisted action type must be described to the LLM.
		foreach ( [ 'navigate', 'search', 'edit_section', 'insert_text', 'format',
			'heading', 'link', 'template', 'bullet', 'image', 'save', 'preview',
			'undo', 'cancel', 'start_dictation', 'stop_dictation' ] as $type ) {
			$this->assertStringContainsString( '"' . $type . '"', $prompt );
		}
	}
}
