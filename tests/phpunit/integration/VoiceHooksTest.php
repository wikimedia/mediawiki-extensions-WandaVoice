<?php

namespace MediaWiki\Extension\WandaVoice\Tests\Integration;

use ExtensionRegistry;
use MediaWiki\Extension\WandaVoice\Hooks\VoiceHooks;
use MediaWiki\Title\Title;
use MediaWikiIntegrationTestCase;
use OutputPage;
use RequestContext;
use Skin;

/**
 * @group WandaVoice
 * @group Database
 * @covers \MediaWiki\Extension\WandaVoice\Hooks\VoiceHooks
 */
class VoiceHooksTest extends MediaWikiIntegrationTestCase {

	private function newOutputPage( int $namespace = NS_MAIN ): OutputPage {
		$context = new RequestContext();
		$context->setTitle( Title::makeTitle( $namespace, 'WandaVoiceTestPage' ) );
		return new OutputPage( $context );
	}

	private function runHook( OutputPage $out ): void {
		VoiceHooks::onBeforePageDisplay( $out, $this->createMock( Skin::class ) );
	}

	public function testNothingAddedWhenDisabled() {
		$this->overrideConfigValues( [ 'WandaVoiceEnabled' => false ] );
		$out = $this->newOutputPage();
		$this->runHook( $out );
		$this->assertNotContains( 'ext.wandavoice', $out->getModules() );
	}

	public function testNothingAddedOutsideConfiguredNamespaces() {
		$this->markTestSkippedIfExtensionNotLoaded( 'Wanda' );
		$this->overrideConfigValues( [
			'WandaVoiceEnabled' => true,
			'WandaVoiceNamespaces' => [ NS_TALK ],
		] );
		$out = $this->newOutputPage( NS_MAIN );
		$this->runHook( $out );
		$this->assertNotContains( 'ext.wandavoice', $out->getModules() );
	}

	public function testModuleAndConfigAddedWhenEnabled() {
		$this->markTestSkippedIfExtensionNotLoaded( 'Wanda' );
		$this->overrideConfigValues( [
			'WandaVoiceEnabled' => true,
			'WandaVoiceNamespaces' => [],
			'WandaVoiceWakePhrase' => 'wanda',
			'WandaVoiceSTTEndpoint' => 'http://localhost:8000/v1/audio/transcriptions',
			'WandaVoiceSTTApiKey' => 'secret-key',
		] );
		$out = $this->newOutputPage();
		$this->runHook( $out );

		$this->assertContains( 'ext.wandavoice', $out->getModules() );
		$vars = $out->getJsConfigVars();
		$this->assertArrayHasKey( 'wgWandaVoice', $vars );
		$clientConfig = $vars['wgWandaVoice'];
		$this->assertSame( 'wanda', $clientConfig['wakePhrase'] );
		// The STT endpoint and key must never be exposed to the client,
		// only a boolean availability flag.
		$this->assertTrue( $clientConfig['serverSTT'] );
		$this->assertStringNotContainsString(
			'secret-key', json_encode( $clientConfig )
		);
		$this->assertStringNotContainsString(
			'localhost:8000', json_encode( $clientConfig )
		);
	}

	public function testNamespaceListAllowsConfiguredNamespace() {
		$this->markTestSkippedIfExtensionNotLoaded( 'Wanda' );
		$this->overrideConfigValues( [
			'WandaVoiceEnabled' => true,
			'WandaVoiceNamespaces' => [ NS_TALK ],
		] );
		$out = $this->newOutputPage( NS_TALK );
		$this->runHook( $out );
		$this->assertContains( 'ext.wandavoice', $out->getModules() );
	}

	protected function markTestSkippedIfExtensionNotLoaded( string $extension ): void {
		if ( !ExtensionRegistry::getInstance()->isLoaded( $extension ) ) {
			$this->markTestSkipped( "The $extension extension is not loaded" );
		}
	}
}
