<?php

namespace MediaWiki\Extension\WandaVoice\Tests\Unit;

use MediaWiki\Extension\WandaVoice\ApiWandaVoiceTranscribe;
use MediaWikiUnitTestCase;
use ReflectionClass;
use Wikimedia\ParamValidator\ParamValidator;

/**
 * @group WandaVoice
 * @covers \MediaWiki\Extension\WandaVoice\ApiWandaVoiceTranscribe
 */
class ApiWandaVoiceTranscribeTest extends MediaWikiUnitTestCase {

	/**
	 * Get a private constant from ApiWandaVoiceTranscribe.
	 *
	 * @param string $name
	 * @return mixed
	 */
	private function getPrivateConstant( string $name ) {
		$class = new ReflectionClass( ApiWandaVoiceTranscribe::class );
		return $class->getConstant( $name );
	}

	public function testMustBePosted() {
		$class = new ReflectionClass( ApiWandaVoiceTranscribe::class );
		$api = $class->newInstanceWithoutConstructor();
		$this->assertTrue( $api->mustBePosted() );
	}

	public function testGetAllowedParams() {
		$class = new ReflectionClass( ApiWandaVoiceTranscribe::class );
		$api = $class->newInstanceWithoutConstructor();

		$this->assertSame( [
			'audio' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_REQUIRED => true
			],
			'mimetype' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_DEFAULT => 'audio/webm'
			],
			'lang' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_DEFAULT => ''
			]
		], $api->getAllowedParams() );
	}

	public function testMimeExtensionsSupported() {
		$mimeExtensions = $this->getPrivateConstant( 'MIME_EXTENSIONS' );

		$this->assertSame( [
			'audio/webm' => 'webm',
			'audio/ogg' => 'ogg',
			'audio/mp4' => 'mp4',
			'audio/mpeg' => 'mp3',
			'audio/wav' => 'wav'
		], $mimeExtensions );
	}

	public function testGetExamplesMessages() {
		$class = new ReflectionClass( ApiWandaVoiceTranscribe::class );
		$api = $class->newInstanceWithoutConstructor();

		$method = $class->getMethod( 'getExamplesMessages' );

		$this->assertSame( [
			'action=wandavoicetranscribe&audio=BASE64AUDIO&mimetype=audio/webm&format=json'
				=> 'apihelp-wandavoicetranscribe-example-simple'
		], $method->invoke( $api ) );
	}
}
